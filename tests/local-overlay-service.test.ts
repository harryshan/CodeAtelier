/**
 * Local overlay 持久生命周期和 Engine 接线的跨平台回归。
 * 1. FakeBackend 只替换挂载/冻结边界；目录、清单、锁、Store 和 Engine 均使用真实实现。
 * 2. 创建测试覆盖绑定重试、只读拒绝不污染、未知挂载保留和身份替换。
 * 3. 租约测试覆盖同视图互斥、不同视图并行、跨进程 active 拒绝及完成/失败/取消续轮。
 * 4. Engine 测试检查执行期间挂载、私有提示、来源记忆映射、排空后的冻结和 unknown 隔离。
 * 假后端不证明文件系统隔离/ACL；真实 WinFsp 与 Sandbox 由手动 verifier 验证。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import type { LocalOverlayBackend } from "../src/local-overlays/backend.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { directoryIdentity } from "../src/worktrees/git.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { TestEngine, TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";

const log = pino({ enabled: false });

class FakeBackend implements LocalOverlayBackend {
  readonly mounted = new Set<string>();
  readonly epochs = new Map<string, number>();
  creates = 0;
  failOpen = false;
  failFinish = false;

  constructor(readonly root: string) {}

  workspace(id: string) {
    return path.join(this.root, id);
  }

  idFor(workspace: string) {
    return path.dirname(workspace) === this.root
      ? path.basename(workspace)
      : undefined;
  }

  async open(
    id: string,
    _source: string,
    control: string,
    create: boolean,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.failOpen) {
      throw new Error("mount failed");
    }

    if (this.mounted.has(id)) {
      throw new Error("already mounted");
    }

    if (create) {
      this.creates++;
      await mkdir(control);
      await mkdir(this.workspace(id));
    }

    this.mounted.add(id);

    return {
      identity: () => directoryIdentity(this.workspace(id)),
      close: async () => {
        this.mounted.delete(id);
      },
      finish: async () => {
        if (this.failFinish) {
          throw new Error("freeze failed");
        }

        const epoch = (this.epochs.get(id) ?? 0) + 1;
        this.epochs.set(id, epoch);
        this.mounted.delete(id);

        return { epoch, capturedPaths: 1 };
      },
    };
  }
}

async function fixture() {
  const source = await temp();
  const directory = await temp();
  const backend = new FakeBackend(await temp());
  const service = new LocalOverlayService(directory, log, backend);
  const store = new TestStore(path.join(directory, "history.sqlite"));
  const id = randomUUID();
  // The binder recovers a session saved before a lost manifest acknowledgement.
  const bind = async (workspace: string) =>
    store.list().find((s) => s.workspace === workspace) ??
    store.create(workspace, "Local fixture");
  const create = () => service.create({ id, source }, bind);
  const record = async () =>
    JSON.parse(await readFile(path.join(service.root, `${id}.json`), "utf8"));

  return {
    source,
    directory,
    backend,
    service,
    store,
    id,
    bind,
    create,
    record,
  };
}

it("binds once without mounting during admission and maps memory to the source", async () => {
  const f = await fixture();
  const session = await f.create();
  expect((await f.create()).id).toBe(session.id);
  expect(f.backend.creates).toBe(1);
  expect(f.backend.mounted.size).toBe(0);
  expect(await f.service.projectWorkspace(session.workspace)).toBe(f.source);
  expect(await f.service.validate(f.source)).toBeUndefined();
  await expect(
    f.service.validate(session.workspace, randomUUID()),
  ).rejects.toThrow("身份改变");
  expect((await f.record()).phase).toBe("ready");
});

it("retries only session binding after its acknowledgement is lost", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ id: f.id, source: f.source }, async (workspace) => {
      await f.bind(workspace);
      throw new Error("binding reply lost");
    }),
  ).rejects.toThrow("binding reply lost");
  const session = await f.create();
  expect(f.store.list()).toHaveLength(1);
  expect(f.backend.creates).toBe(1);
  expect((await f.record()).sessionId).toBe(session.id);
});

it("does not quarantine or lock a healthy view after a mismatched creation request", async () => {
  const f = await fixture();
  const session = await f.create();
  const before = await f.record();
  await expect(
    f.service.create({ id: f.id, source: await temp() }, f.bind),
  ).rejects.toThrow("其它状态或来源");
  expect(await f.record()).toEqual(before);
  expect((await f.create()).id).toBe(session.id);
});

it("rejects overlapping private data before starting a mount", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ id: f.id, source: f.directory }, f.bind),
  ).rejects.toThrow("重叠");
  expect(f.backend.creates).toBe(0);
});

it("retains failed preparation and its lock rather than recreating it", async () => {
  const f = await fixture();
  f.backend.failOpen = true;
  await expect(f.create()).rejects.toThrow("mount failed");
  expect((await f.record()).phase).toBe("failed");
  f.backend.failOpen = false;
  await expect(f.create()).rejects.toThrow("不会抢占");
  expect(f.backend.creates).toBe(0);
});

it("refuses replaced control directories without changing the ready manifest", async () => {
  const f = await fixture();
  const session = await f.create();
  const control = path.join(f.service.root, f.id);
  await rename(control, `${control}-old`);
  await mkdir(control);
  await expect(
    f.service.begin(
      session.workspace,
      session.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("身份改变");
  expect((await f.record()).phase).toBe("ready");
  expect(f.backend.mounted.size).toBe(0);
});

it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
  "retains private content and advances after drained %s",
  async (status) => {
    const f = await fixture();
    const session = await f.create();
    const begin = () =>
      f.service.begin(
        session.workspace,
        session.id,
        randomUUID(),
        new AbortController().signal,
      );
    const first = (await begin())!;
    await writeFile(path.join(session.workspace, "private.txt"), "keep");
    await expect(begin()).rejects.toThrow("不会抢占");
    const peer = new LocalOverlayService(f.directory, log, f.backend);
    await expect(peer.validate(session.workspace)).rejects.toThrow("身份改变");
    await expect(first.finish(status, true)).resolves.toMatchObject({
      phase: "ready",
      outcome: status,
      epoch: 1,
    });
    await first.finish(status, true);
    expect(f.backend.epochs.get(f.id)).toBe(1);
    const second = (await begin())!;
    expect(
      await readFile(path.join(session.workspace, "private.txt"), "utf8"),
    ).toBe("keep");
    await second.finish("completed", true);
    expect((await f.record()).epoch).toBe(2);
  },
);

it.each(["drain", "freeze"])(
  "quarantines an unknown %s without allowing resume",
  async (failure) => {
    const f = await fixture();
    const session = await f.create();
    const lease = (await f.service.begin(
      session.workspace,
      session.id,
      randomUUID(),
      new AbortController().signal,
    ))!;
    f.backend.failFinish = failure === "freeze";
    await expect(
      lease.finish("cancelled", failure !== "drain"),
    ).rejects.toThrow();
    expect((await f.record()).phase).toBe("failed");
    expect(f.backend.mounted.size).toBe(0);
    await expect(f.service.validate(session.workspace)).rejects.toThrow(
      "身份改变",
    );
    expect(
      await readFile(path.join(f.service.root, `${f.id}.lock`), "utf8"),
    ).toBe("");
    await f.service.close();
  },
);

it("mounts separate views concurrently and prevents close while tasks are active", async () => {
  const f = await fixture();
  const a = await f.create();
  const b = await f.service.create(
    { id: randomUUID(), source: f.source },
    f.bind,
  );
  const leases = await Promise.all(
    [a, b].map((s) =>
      f.service.begin(
        s.workspace,
        s.id,
        randomUUID(),
        new AbortController().signal,
      ),
    ),
  );
  expect(f.backend.mounted.size).toBe(2);
  await expect(f.service.close()).rejects.toThrow("尚未排空");
  await Promise.all(leases.map((lease) => lease!.finish("completed", true)));
  await f.service.close();
});

it("quarantines a changed mounted volume identity and retains the new mount's lock", async () => {
  const f = await fixture();
  const session = await f.create();
  await rename(session.workspace, `${session.workspace}-old`);
  await mkdir(session.workspace);
  await expect(
    f.service.begin(
      session.workspace,
      session.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("卷身份改变");
  expect((await f.record()).phase).toBe("failed");
  expect(f.backend.mounted.size).toBe(0);
  await expect(f.create()).rejects.toThrow("不会抢占");
});

it("refuses a stale active manifest after restart without mounting or changing it", async () => {
  const f = await fixture();
  const session = await f.create();
  const stale = {
    ...(await f.record()),
    phase: "active",
    taskId: randomUUID(),
  };
  await writeFile(
    path.join(f.service.root, `${f.id}.json`),
    JSON.stringify(stale),
  );
  const restarted = new LocalOverlayService(f.directory, log, f.backend);
  await expect(
    restarted.begin(
      session.workspace,
      session.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("身份改变");
  expect(await f.record()).toEqual(stale);
  expect(f.backend.mounted.size).toBe(0);
});

it.each([false, true])(
  "Engine mounts before the model and freezes after task exit (model failure=%s)",
  async (fail) => {
    const f = await fixture();
    const config = new Config(f.directory);
    let calls = 0;
    let workspace = "";
    const provider: ModelProvider = {
      async run(_input, instructions) {
        calls++;
        expect(f.backend.mounted.has(f.id)).toBe(true);
        expect(instructions).toContain("private Local overlay view");
        await writeFile(path.join(workspace, "private.txt"), `turn ${calls}`);
        if (fail) {
          throw new Error("deliberate model failure");
        }

        return { text: "done", output: [] };
      },
    };
    const engine = new TestEngine(
      f.store,
      config,
      log,
      () => provider,
      undefined,
      undefined,
      f.backend,
    );
    const session = await engine.localOverlays.create(
      { id: f.id, source: f.source },
      f.bind,
    );
    workspace = session.workspace;
    for (let turn = 1; turn <= 2; turn++) {
      const task = await engine.start(session.id, "write privately");
      await engine.active?.done;
      expect(f.store.task(task.id)?.status).toBe(fail ? "failed" : "completed");
      expect(f.backend.mounted.size).toBe(0);
      expect((await f.record()).epoch).toBe(turn);
      expect(
        f.store
          .events(session.id)
          .some(
            (e) =>
              e.taskId === task.id &&
              e.type === "local_overlay" &&
              e.data.published === false,
          ),
      ).toBe(true);
    }

    await expect(
      readFile(path.join(f.source, "private.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await engine.localOverlays.projectWorkspace(workspace)).toBe(
      f.source,
    );
    await engine.close();
  },
);

it("Engine shutdown cancels and drains the model before closing its private view", async () => {
  const f = await fixture();
  const config = new Config(f.directory);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let abortedWhileMounted = false;
  const provider: ModelProvider = {
    async run(_input, _instructions, _tools, signal) {
      enter();
      await new Promise<void>((_resolve, reject) => {
        const aborted = () => {
          abortedWhileMounted = f.backend.mounted.has(f.id);
          reject(signal.reason);
        };

        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) {
          aborted();
        }
      });

      return { text: "unexpected", output: [] };
    },
  };
  const engine = new TestEngine(
    f.store,
    config,
    log,
    () => provider,
    undefined,
    undefined,
    f.backend,
  );
  const session = await engine.localOverlays.create(
    { id: f.id, source: f.source },
    f.bind,
  );
  const task = await engine.start(session.id, "wait until cancelled");
  await entered;
  await engine.close();
  expect(abortedWhileMounted).toBe(true);
  expect(f.backend.mounted.size).toBe(0);
  expect(f.store.task(task.id)?.status).toBe("interrupted");
  expect(await f.record()).toMatchObject({
    phase: "ready",
    outcome: "interrupted",
    epoch: 1,
  });
});

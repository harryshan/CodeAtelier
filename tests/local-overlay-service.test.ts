/**
 * Local overlay 持久生命周期和 Engine 接线的跨平台回归。
 * 1. FakeBackend 只替换挂载/冻结边界；目录、清单、锁、Store 和 Engine 均使用真实实现。
 * 2. 创建测试覆盖绑定重试、只读拒绝不污染、未知挂载保留和身份替换。
 * 3. 租约测试覆盖同视图互斥、不同视图并行、跨进程 active 拒绝及完成/失败/取消续轮。
 * 4. Engine 测试检查执行期间挂载、私有提示、来源记忆映射、排空后的冻结和 unknown 隔离；请求 Sandbox 的启动失败不得执行宿主模型或留下 fallback 事件。
 * 5. 真实 stdio Runtime 子进程执行模型 local_publish，验证选定/撤销和普通任务拒绝；模拟模式不是 OS Sandbox 证据。
 * 假后端不证明文件系统隔离/ACL；真实 WinFsp 与 Sandbox 由手动 verifier 验证。
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { FakeLocalOverlayBackend as FakeBackend } from "./fixtures/local-overlay-backend.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { TestEngine, TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import { createRuntimeChildClose } from "./fixtures/runtime-child-close.js";
import { currentTestResources } from "./fixtures/test-resources.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
import { AgentRuntimeFallbackError } from "../src/sandbox/agent-runtime-launcher.js";

const log = pino({ enabled: false });

// Real child/IPC, simulated mode only. This cannot prove OS isolation or mount semantics.
const protocolLauncher: AgentRuntimeLauncher = {
  async launch(input) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("tests/fixtures/agent-runtime-service-child.ts"),
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEATELIER_TEST_RUNTIME_DESCRIPTOR: JSON.stringify({
            identity: input.identity,
            nonce: input.nonce,
          }),
        },
      },
    );
    child.stderr.resume();
    const close = createRuntimeChildClose(child);
    currentTestResources().defer(async () => {
      await close();
    });

    return {
      input: child.stdout,
      output: child.stdin,
      pid: child.pid!,
      mode: "windows-sandbox-user",
      close,
    };
  },
};

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

it("never executes a Local overlay task on the host after requested Sandbox startup fails", async () => {
  const f = await fixture();
  const config = new Config(f.directory);
  config.sandbox.enabled = true;
  let hostCalls = 0;
  const engine = new TestEngine(
    f.store,
    config,
    log,
    () => ({
      async run(_input, _instructions, tools) {
        if (tools.length) {
          hostCalls++;
        }

        return { text: "host must not execute", output: [] };
      },
    }),
    {
      launch: async () => {
        throw new AgentRuntimeFallbackError();
      },
    },
    undefined,
    f.backend,
  );
  const session = await engine.localOverlays.create(
    { id: f.id, source: f.source },
    f.bind,
  );
  const task = await engine.start(session.id, "must stay isolated");
  await engine.active?.done;
  expect(hostCalls).toBe(0);
  expect(f.store.task(task.id)?.status).toBe("failed");
  expect(
    f.store
      .events(session.id)
      .filter((event) => event.taskId === task.id)
      .some(
        (event) =>
          event.type === "sandbox_fallback" ||
          event.data?.mode === "host-process-fallback",
      ),
  ).toBe(false);
  expect(await f.record()).toMatchObject({ phase: "ready", outcome: "failed" });
  expect(f.backend.publications).toHaveLength(0);
  await engine.close();
});

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

it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
  "only passes explicit selection to drained successful finish (%s)",
  async (status) => {
    const f = await fixture();
    const session = await f.create();
    const taskId = randomUUID();
    const lease = (await f.service.begin(
      session.workspace,
      session.id,
      taskId,
      new AbortController().signal,
    ))!;
    const paths = ["source.ts"];
    const selection = { paths, validate: async () => {} };
    await expect(
      f.service.select(session.workspace, session.id, randomUUID(), selection),
    ).rejects.toThrow("当前活动");
    await f.service.select(session.workspace, session.id, taskId, selection);
    paths.push("artifact.bin");
    await lease.finish(status, true);
    expect(f.backend.publications).toHaveLength(status === "completed" ? 1 : 0);
    if (status === "completed") {
      expect(f.backend.publications[0]!.paths).toEqual(["source.ts"]);
    }

    await expect(
      f.service.select(session.workspace, session.id, taskId, selection),
    ).rejects.toThrow("当前活动");
    const next = (await f.service.begin(
      session.workspace,
      session.id,
      randomUUID(),
      new AbortController().signal,
    ))!;
    await next.finish("completed", true);
    expect(f.backend.publications).toHaveLength(status === "completed" ? 1 : 0);
  },
);

it("requires a bounded explicit selection and a validator", async () => {
  const f = await fixture();
  const session = await f.create();
  const taskId = randomUUID();
  const lease = (await f.service.begin(
    session.workspace,
    session.id,
    taskId,
    new AbortController().signal,
  ))!;
  for (const paths of [
    [],
    [".git/config"],
    ["../source.ts"],
    ["a.ts", "A.ts"],
    Array.from({ length: 101 }, (_, i) => `${i}.ts`),
  ]) {
    await expect(
      f.service.select(session.workspace, session.id, taskId, {
        paths,
        validate: async () => {},
      }),
    ).rejects.toThrow();
  }

  await expect(
    f.service.select(session.workspace, session.id, taskId, {
      paths: ["a.ts"],
    } as any),
  ).rejects.toThrow("VALIDATOR_REQUIRED");
  await lease.finish("completed", true);
  expect(f.backend.publications).toHaveLength(0);
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

it.each(["select", "clear", "unavailable"] as const)(
  "routes model Local publication through the authenticated Runtime (%s)",
  async (mode) => {
    const f = await fixture();
    const config = new Config(f.directory);
    config.sandbox.enabled = true;
    let calls = 0;
    const provider: ModelProvider = {
      async getCapabilities() {
        return {
          limits: {
            max_context_window_tokens: 32_000,
            max_output_tokens: 1_024,
          },
        };
      },
      async run(input, _instructions, tools) {
        expect(tools.some((tool: any) => tool.name === "local_publish")).toBe(
          mode !== "unavailable",
        );
        calls++;
        if (calls === 1 || (mode === "clear" && calls === 2)) {
          if (calls === 2) {
            expect(JSON.stringify(input)).toContain('\\"published\\":false');
          }

          return {
            text: "",
            output: [
              {
                type: "function_call",
                call_id: `selection-${calls}`,
                name: "local_publish",
                arguments: JSON.stringify({
                  execution: { id: `selection-${calls}`, dependsOn: [] },
                  arguments: {
                    request:
                      calls === 2
                        ? { action: "clear" }
                        : {
                            action: "select",
                            paths: ["a.ts"],
                            commands: ["echo candidate"],
                          },
                  },
                }),
              },
            ],
          };
        }

        expect(JSON.stringify(input)).toContain(
          mode === "unavailable" ? "未启用 Local" : '\\"published\\":false',
        );

        return {
          text: "Selection handled; not a publication receipt.",
          output: [],
        };
      },
    };
    const engine = new TestEngine(
      f.store,
      config,
      log,
      () => provider,
      protocolLauncher,
      undefined,
      f.backend,
    );
    const session =
      mode === "unavailable"
        ? f.store.create(f.source, "ordinary Local")
        : await engine.localOverlays.create(
            { id: f.id, source: f.source },
            f.bind,
          );
    const task = await engine.start(session.id, "select source changes");
    await engine.active?.done;
    expect(f.store.task(task.id)?.status).toBe("completed");
    expect(f.backend.publications).toHaveLength(mode === "select" ? 1 : 0);
    if (mode === "select") {
      expect(f.backend.publications[0]?.paths).toEqual(["a.ts"]);
    }

    const events = f.store
      .events(session.id)
      .filter((event) => event.taskId === task.id);
    const results = events.filter(
      (event) =>
        event.type === "tool_result" && event.data.name === "local_publish",
    );
    expect(results).toHaveLength(mode === "clear" ? 2 : 1);
    expect(results[0]!.data.result).toMatchObject(
      mode === "unavailable"
        ? { error: expect.any(String) }
        : { selected: 1, published: false },
    );
    if (mode === "clear") {
      expect(results[1]!.data.result).toEqual({
        selected: 0,
        published: false,
      });
    }

    const trace = JSON.parse((await engine.savedTrace(task))!);
    const selectionSpans = trace.traceEvents.filter(
      (event: any) => event.name === "tool.local_publish",
    );
    if (mode === "unavailable") {
      expect(selectionSpans).toHaveLength(0);
    } else {
      expect(selectionSpans.length).toBeGreaterThan(0);
    }

    expect(JSON.stringify(selectionSpans)).not.toContain("echo candidate");
    expect(JSON.stringify(selectionSpans)).not.toContain("a.ts");

    await engine.close();
  },
);

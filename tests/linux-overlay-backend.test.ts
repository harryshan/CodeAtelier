/**
 * Linux backend/Service 的普通目录协议回归，不提供内核挂载或 Sandbox 验收证据。
 * 1. fixture 仅替换控制器，以普通目录和真实元数据生成最小 seal；Store/Service/Publisher 使用正式实现。
 * 2. 验证 Linux 格式绑定、无选集收尾/续轮及失败任务保留，不依赖重挂载 inode。
 * 3. 发布测试验证 complete 后选定覆盖移除、刷新失败 pending 保留、未知 seal 禁止重新打开。
 * 4. 候选测试核对内容变更拒绝、未知排空保留、正常清理；执行器替身不宣称真实 Sandbox。
 */
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import {
  LinuxLocalBackend,
  type LinuxMountController,
} from "../src/local-overlays/linux-backend.js";
import { LinuxCandidateValidator } from "../src/local-overlays/linux-candidate.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";

const log = pino({ enabled: false });
const signal = () => new AbortController().signal;

it("classifies a lost candidate mount receipt as unknown rather than validation rejection", async () => {
  const f = await fixture();
  const controller: LinuxMountController = {
    ...f.controller,
    open: async (...args) => {
      await f.controller.open(...args);
      throw new Error("mount receipt lost");
    },
  };
  const validator = new LinuxCandidateValidator(f.root, controller, log);
  await expect(
    validator.validate(
      f.source,
      new Map([["code.txt", Buffer.from("candidate\n")]]),
      async () => {
        throw new Error("Executor must not start");
      },
      signal(),
    ),
  ).rejects.toThrow("排空未确认");
  expect(f.active.size).toBe(1);
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "original\n",
  );
});

async function fixture() {
  const directory = await temp();
  const root = path.join(directory, "local-overlays");
  await mkdir(root);
  const source = await temp();
  await writeFile(path.join(source, "code.txt"), "original\n");
  const active = new Set<string>();
  const faults = { seal: false, release: false };
  const controller: LinuxMountController = {
    async open(id, _source, create) {
      const privateRoot = path.join(root, id);
      if (create) {
        await mkdir(privateRoot);
        for (const part of ["view", "upper", "control"]) {
          await mkdir(path.join(privateRoot, part));
        }

        await copyFile(
          path.join(source, "code.txt"),
          path.join(privateRoot, "view", "code.txt"),
        );
      }

      active.add(id);

      return {
        workspace: path.join(privateRoot, "view"),
        upper: path.join(privateRoot, "upper"),
        control: path.join(privateRoot, "control"),
        ready: {
          state: "ready",
          valid: true,
          nodes: 1,
          objects: 0,
          copiedBytes: 0,
          sourceOpens: 0,
          enumerations: 0,
        },
      };
    },
    async seal(id) {
      if (faults.seal) {
        throw new Error("seal unknown");
      }

      const entries = [];
      for (const file of [".", "code.txt"]) {
        const info = await lstat(path.join(source, file), { bigint: true });
        const identity = `${info.dev}:${info.ino}`;
        entries.push({
          path: file,
          kind: file === "." ? "directory" : "file",
          identity,
          stamp: `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`,
          mode: Number(info.mode),
          links: Number(info.nlink),
          object: null,
          objectStamp: null,
          members: file === "." ? ["code.txt\0f"] : null,
        });
      }

      const sealId = randomUUID();
      await writeFile(
        path.join(root, id, "control", `${sealId}.json`),
        JSON.stringify({
          version: 1,
          id: sealId,
          source: await sourceIdentity(source),
          entries,
        }),
      );

      return sealId;
    },
    async close(id) {
      active.delete(id);
    },
    async release(id, remove) {
      expect(active.has(id)).toBe(false);
      if (faults.release) {
        throw new Error("release unknown");
      }

      for (const entry of remove) {
        await unlink(path.join(root, id, "upper", entry.path));
      }
    },
  };
  const backend = new LinuxLocalBackend(root, controller, log);
  const service = new LocalOverlayService(directory, log, backend);
  const store = new TestStore(path.join(directory, "history.sqlite"));
  const id = randomUUID();
  const session = await service.create({ id, source }, async (workspace) =>
    store.create(workspace, "Linux fixture"),
  );
  const begin = () =>
    service.begin(session.workspace, session.id, randomUUID(), signal());
  const edit = async () => {
    await writeFile(path.join(session.workspace, "code.txt"), "private\n");
    await copyFile(
      path.join(session.workspace, "code.txt"),
      path.join(root, id, "upper", "code.txt"),
    );
  };

  return {
    directory,
    root,
    source,
    id,
    session,
    service,
    begin,
    edit,
    backend,
    controller,
    active,
    faults,
  };
}

it("binds Linux format and persists failed/normal task rounds without publishing", async () => {
  const f = await fixture();
  expect((await f.service.validate(f.session.workspace))?.format).toBe(
    "linux-overlay-v1",
  );
  const lease = await f.begin();
  await f.edit();
  const result = await lease!.finish("failed", true);
  expect(result).toMatchObject({
    phase: "ready",
    outcome: "failed",
    capturedPaths: 1,
  });
  expect(f.active.size).toBe(0);
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "original\n",
  );
  const next = await f.begin();
  expect((await next!.finish("completed", true)).epoch).toBe(2);
});

it.each([false, true])(
  "publishes selected source and retains pending on release failure=%s",
  async (fail) => {
    const f = await fixture();
    const taskId = randomUUID();
    const lease = await f.service.begin(
      f.session.workspace,
      f.session.id,
      taskId,
      signal(),
    );
    await f.edit();
    await f.service.select(f.session.workspace, f.session.id, taskId, {
      paths: ["code.txt"],
      validate: async (files) => {
        expect(files.get("code.txt")?.toString()).toBe("private\n");
      },
    });
    f.faults.release = fail;
    if (fail) {
      await expect(lease!.finish("completed", true)).rejects.toThrow(
        "release unknown",
      );
      await expect(
        f.backend.open(
          f.id,
          f.source,
          path.join(f.root, f.id),
          false,
          signal(),
        ),
      ).rejects.toThrow("ROUND_PENDING");
      expect(
        await readFile(path.join(f.root, f.id, "upper", "code.txt"), "utf8"),
      ).toBe("private\n");
    } else {
      expect(await lease!.finish("completed", true)).toMatchObject({
        phase: "ready",
        publication: { state: "published" },
      });
      expect(await readdir(path.join(f.root, f.id, "upper"))).toEqual([]);
    }

    expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
      "private\n",
    );
  },
);

it("keeps pending and refuses reopening after unknown seal", async () => {
  const f = await fixture();
  const lease = await f.begin();
  f.faults.seal = true;
  await expect(lease!.finish("completed", true)).rejects.toThrow(
    "seal unknown",
  );
  await expect(
    f.backend.open(f.id, f.source, path.join(f.root, f.id), false, signal()),
  ).rejects.toThrow("ROUND_PENDING");
});

it("retains a ready private view when candidate validation fails before publication", async () => {
  const f = await fixture();
  const taskId = randomUUID();
  const lease = await f.service.begin(
    f.session.workspace,
    f.session.id,
    taskId,
    signal(),
  );
  await f.edit();
  await f.service.select(f.session.workspace, f.session.id, taskId, {
    paths: ["code.txt"],
    validate: async () => {
      throw new Error("validation failed");
    },
  });
  expect(await lease!.finish("completed", true)).toMatchObject({
    phase: "ready",
    outcome: "failed",
    publication: { state: "rejected", reason: "VALIDATION_FAILED" },
  });
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "original\n",
  );
  expect(
    await readFile(path.join(f.root, f.id, "upper", "code.txt"), "utf8"),
  ).toBe("private\n");
});

it.each(["pass", "changed", "unknown"])(
  "handles candidate %s with the matching cleanup boundary",
  async (mode) => {
    const f = await fixture();
    const validator = new LinuxCandidateValidator(f.root, f.controller, log);
    const result = validator.validate(
      f.source,
      new Map([["code.txt", Buffer.from("candidate\n")]]),
      async (workspace) => {
        expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
          "candidate\n",
        );
        if (mode === "changed") {
          await writeFile(path.join(workspace, "code.txt"), "changed\n");
        }

        return {
          drained: mode !== "unknown",
          sandboxApplied: true,
          exitCode: 0,
        };
      },
      signal(),
    );
    if (mode === "pass") {
      await expect(result).resolves.toMatchObject({ reads: expect.any(Array) });
    } else {
      await expect(result).rejects.toThrow(
        mode === "changed" ? "CANDIDATE_CHANGED" : "排空未确认",
      );
    }

    expect(f.active.size).toBe(mode === "unknown" ? 1 : 0);
    expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
      "original\n",
    );
  },
);

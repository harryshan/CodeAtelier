/**
 * Local 清单读取与原子保存的竞争回归，使用真实文件和 FakeBackend 生命周期。
 * 1. 延迟指定清单的 open 返回，固定一个真实只读句柄仍打开的窗口。
 * 2. 在同一窗口完成任务，Windows 实机 rename 会 EPERM；跨平台以相同拒绝模型复现。
 * 3. 释放读取后必须保存 ready 并解除正常服务租约；不能因 UI 历史读取隔离健康私有卷。
 * 只在同一 Service 内测试 I/O 排队，不证明外部进程、杀毒软件或其它卷的共享语义。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import type { Session } from "../src/shared/types.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";

const control = vi.hoisted(() => ({
  gate: undefined as
    { file: string; entered: () => void; released: Promise<void> } | undefined,
  held: "",
}));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const gate = control.gate;
      if (gate && args[0] === gate.file) {
        control.gate = undefined;
        control.held = gate.file;
        gate.entered();
        await gate.released;
        control.held = "";
      }

      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === control.held) {
        throw Object.assign(
          new Error("Open reader blocks atomic replacement"),
          { code: "EPERM" },
        );
      }

      return actual.rename(...args);
    },
  };
});

it("finishes publication bookkeeping after the concurrent history reader closes", async () => {
  const directory = await temp();
  const backend = new FakeLocalOverlayBackend(await temp());
  const service = new LocalOverlayService(
    directory,
    pino({ enabled: false }),
    backend,
  );
  const id = randomUUID();
  const session = await service.create(
    { id, source: await temp() },
    async (workspace) => ({ id: randomUUID(), workspace }) as Session,
  );
  const task = randomUUID();
  const lease = await service.begin(
    session.workspace,
    session.id,
    task,
    new AbortController().signal,
  );
  await service.select(session.workspace, session.id, task, {
    paths: ["code.txt"],
    validate: async () => {},
  });
  const file = path.join(service.root, `${id}.json`);
  let release!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  control.gate = {
    file,
    entered,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const reading = service.describe(session);
  await opened;
  const finishing = lease!.finish("completed", true);
  const outcome = finishing.then(
    (record) => ({ record, error: undefined }),
    (error: unknown) => ({ record: undefined, error }),
  );
  try {
    await delay(100);
  } finally {
    release();
  }

  await reading;
  const result = await outcome;
  expect(result.error).toBeUndefined();
  expect(result.record?.phase).toBe("ready");
  expect(JSON.parse(await readFile(file, "utf8")).phase).toBe("ready");
  await expect(
    readFile(path.join(service.root, `${id}.lock`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(backend.mounted.size).toBe(0);
  await service.close();
});

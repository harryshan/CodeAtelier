/**
 * 验证宿主 OverlayManager 的协议、取消和失败关闭边界，不模拟文件系统正确性。
 * 1. 使用管道夹具控制 ready/stopped/close，检查只接受完整收据且同一请求去重。
 * 2. helper 异常退出后不得在本进程重挂载；取消必须等待停止，关闭必须证明 stopped + exit 0。
 * 3. 校验托管 UNC 命名空间不能将子目录或另一数据目录误认作同一个挂载。
 * 原生文件、Git 和受限 token 语义由手动 verify-winfsp-overlay 独立验证。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { beforeEach, expect, it, vi } from "vitest";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  overlayWorkspaceId,
} from "../src/worktrees/overlay.js";
import { temp } from "./fixtures/helpers.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

class Helper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor(clean = true) {
    super();
    this.stdin.on("finish", () => {
      if (this.killed) {
        return;
      }

      if (clean) {
        this.stdout.write('{"version":1,"state":"stopped"}\n');
      }

      this.emit("close", clean ? 0 : 1);
    });
  }

  kill() {
    this.killed = true;
    this.emit("close", 1);
  }

  ready() {
    this.stdout.write('{"version":1,"state":"ready"}\n');
  }
}

beforeEach(() => spawn.mockReset());

async function fixture(helper = new Helper()) {
  spawn.mockImplementation(() => helper);
  const directory = await temp();
  const manager = new OverlayManager(
    directory,
    pino({ enabled: false }),
    "fixed-helper",
  );
  const id = randomUUID();
  const workspace = overlayWorkspace(overlayNamespace(directory), id);
  const controller = new AbortController();
  const start = () =>
    manager.start(id, directory, directory, workspace, true, controller.signal);

  return { helper, manager, controller, start };
}

it("waits for ready, deduplicates the mount and proves clean shutdown", async () => {
  const f = await fixture();
  let ready = false;
  const first = f.start().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  const duplicate = f.start();
  f.helper.ready();
  await Promise.all([first, duplicate]);
  expect(spawn).toHaveBeenCalledTimes(1);
  await f.manager.close();
  await f.manager.close();
  expect(f.helper.stdin.writableEnded).toBe(true);
  expect(f.helper.killed).toBe(false);
});

it("blocks reuse after an unexpected exit without creating another helper", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  f.helper.kill();
  await expect(f.start()).rejects.toThrow("失去挂载");
  await expect(f.manager.close()).rejects.toThrow("清理未全部完成");
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("cancels a pending mount and drains its stdin before reporting failure", async () => {
  const f = await fixture();
  const starting = f.start();
  f.controller.abort();
  await expect(starting).rejects.toThrow();
  expect(f.helper.stdin.writableEnded).toBe(true);
  await f.manager.close();
});

it("rejects incompatible readiness and an exit without a clean receipt", async () => {
  const f = await fixture(new Helper(false));
  const starting = f.start();
  f.helper.stdout.write('{"version":2,"state":"ready"}\n');
  await expect(starting).rejects.toThrow();
  await expect(f.manager.close()).rejects.toThrow("清理未全部完成");
});

it("recognizes only its exact managed UNC share roots", () => {
  const namespace = overlayNamespace("fixture-data");
  const id = randomUUID();
  const workspace = overlayWorkspace(namespace, id);
  expect(overlayWorkspaceId(namespace, workspace)).toBe(id);
  expect(
    overlayWorkspaceId(overlayNamespace("another-data"), workspace),
  ).toBeUndefined();
  expect(() => overlayWorkspaceId(namespace, `${workspace}child`)).toThrow(
    "子目录",
  );
});

it("unmounts a failed creation without stopping another ready workspace", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  const peer = new Helper();
  spawn.mockReturnValueOnce(peer);
  const id = randomUUID();
  const mounting = f.manager.start(
    id,
    "source",
    "control",
    overlayWorkspace("peer", id),
    true,
    f.controller.signal,
  );
  peer.ready();
  await mounting;
  await f.manager.stop(id);
  expect(peer.stdin.writableEnded).toBe(true);
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

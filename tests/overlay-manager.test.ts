/**
 * 验证宿主 OverlayManager 的协议、取消和失败关闭边界，不模拟文件系统正确性。
 * 1. 使用管道夹具控制 ready/stopped/close，检查只接受完整收据且同一请求去重。
 * 2. helper 异常退出后不得在本进程重挂载；取消必须等待停止，关闭必须证明 stopped + exit 0。
 * 3. 校验托管 UNC 命名空间不能将子目录或另一数据目录误认作同一个挂载。
 * 4. Git PoC 显式选择及新旧分段 metrics 收据不能改变 live 挂载协议或终止普通挂载。
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

  return { helper, manager, controller, start, id, workspace, directory };
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

it("reads complete Git PoC metrics without treating them as a stop receipt", async () => {
  const f = await fixture();
  const starting = f.manager.start(
    f.id,
    f.directory,
    f.directory,
    f.workspace,
    true,
    f.controller.signal,
    {
      executable: "fixed-git",
      directory: "fixed-common",
      tree: "a".repeat(40),
    },
  );
  f.helper.ready();
  await starting;
  const pending = f.manager.metrics(f.id);
  await expect(f.manager.metrics(f.id)).rejects.toThrow("already pending");
  const receipt = {
    version: 1,
    state: "metrics",
    treeReads: 0,
    infoReads: 0,
    blobReads: 0,
    blobBytes: 0,
    lowerOpens: 0,
    lowerEnumerations: 0,
  };
  const json = JSON.stringify(receipt);
  f.helper.stdout.write(json.slice(0, 20));
  f.helper.stdout.write(json.slice(20) + "\n");
  expect(await pending).toEqual(receipt);
  const profiled = {
    ...receipt,
    objectMicros: 120,
    sqlPrepareMicros: 4,
    sqlReadMicros: 6,
    sqlWriteMicros: 12,
    sqlExecMicros: 18,
    sqlReads: 3,
    sqlWrites: 2,
    accessCleanups: 1,
  };
  const next = f.manager.metrics(f.id);
  f.helper.stdout.write(JSON.stringify(profiled) + "\n");
  expect(await next).toEqual(profiled);
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

it("rejects metrics on live overlays without sending an unsupported native command", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  await expect(f.manager.metrics(f.id)).rejects.toThrow("unavailable");
  expect(f.helper.stdin.read()).toBeNull();
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

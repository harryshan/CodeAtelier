/**
 * Linux 挂载控制 IPC 的协议回归，使用本机私有 socket/Windows pipe，不冒充 Linux 挂载。
 * 1. fixture 创建独占服务端、跟踪请求和 trace；收尾关闭全部连接并删除仅本测试的临时目录。
 * 2. 正常 open/seal/close 核对 namespace、UUID 和实际响应，验证 trace 不含路径。
 * 3. namespace 失配、断线、响应超限/格式错误和服务端拒绝使客户端失效，不重发副作用。
 * 真正 user/mount namespace、capabilities 撤销和 MXC 兼容由手动 WSL 探针验证。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { LinuxOverlayController } from "../src/local-overlays/linux-controller.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { TraceArchive } from "../src/tracing/archive.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function fixture(
  respond: (request: Record<string, unknown>, socket: Socket) => void,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linux-overlay-ipc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codeatelier-test-${randomUUID()}`
      : path.join(root, "socket");
  const connections = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.endsWith("\n")) {
        const request = JSON.parse(buffer) as Record<string, unknown>;
        requests.push(request);
        respond(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  cleanups.push(async () => {
    for (const socket of connections) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const log = pino({ enabled: false });

  return {
    root,
    requests,
    controller: new LinuxOverlayController(
      endpoint,
      log,
      new TraceRecorder(),
      new TraceArchive(root, log),
      async () => "mnt:[123]",
      1000,
    ),
  };
}

function reply(socket: Socket, value: Record<string, unknown>) {
  socket.end(JSON.stringify({ version: 1, ok: true, ...value }) + "\n");
}

it("binds the namespace and records bounded lifecycle traces without source paths", async () => {
  const sealId = randomUUID();
  const f = await fixture((request, socket) => {
    if (request.operation === "hello") {
      reply(socket, { namespace: "mnt:[123]" });
    } else if (request.operation === "open") {
      reply(socket, {
        workspace: "/private/view",
        control: "/private/control",
        upper: "/private/upper",
        ready: {
          state: "ready",
          valid: true,
          nodes: 1,
          objects: 0,
          copiedBytes: 0,
          sourceOpens: 0,
          enumerations: 0,
        },
      });
    } else {
      reply(socket, { sealId });
    }
  });
  const id = randomUUID();
  expect((await f.controller.open(id, "/secret/source", true)).workspace).toBe(
    "/private/view",
  );
  expect(await f.controller.seal(id)).toBe(sealId);
  await f.controller.close(id);
  expect(f.requests.map((request) => request.operation)).toEqual([
    "hello",
    "open",
    "seal",
    "close",
  ]);
  expect(f.requests[1]).toMatchObject({
    id,
    create: true,
    source: "/secret/source",
  });
  const traces = path.join(f.root, "traces", id);
  expect(await readdir(traces)).toHaveLength(3);
  for (const file of await readdir(traces)) {
    const text = await readFile(path.join(traces, file), "utf8");
    expect(text).not.toContain("/secret/source");
    expect(text).toContain("local_overlay.linux.");
  }
});

it("refuses another namespace before sending a mount request", async () => {
  const f = await fixture((_request, socket) =>
    reply(socket, { namespace: "mnt:[other]" }),
  );
  await expect(
    f.controller.open(randomUUID(), "/source", true),
  ).rejects.toThrow("namespace");
  expect(f.requests).toHaveLength(1);
});

it.each([
  "disconnect",
  "oversize",
  "malformed",
  "reject",
  "bad-open",
  "timeout",
])("never replays after %s", async (failure) => {
  const f = await fixture((request, socket) => {
    if (request.operation === "hello") {
      reply(socket, { namespace: "mnt:[123]" });
    } else if (failure === "disconnect") {
      socket.destroy();
    } else if (failure === "oversize") {
      socket.end("x".repeat(65537));
    } else if (failure === "malformed") {
      socket.end("invalid\n");
    } else if (failure === "reject") {
      reply(socket, { ok: false });
    } else if (failure !== "timeout") {
      reply(socket, {});
    }
  });
  const id = randomUUID();
  await expect(f.controller.open(id, "/source", true)).rejects.toThrow();
  await expect(f.controller.open(id, "/source", true)).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
});

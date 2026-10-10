/**
 * 验证统一流入口通过真实 Node 子进程连接生产 Runtime 服务和 Broker adapter，不只测试字节 echo。
 * 1. launch 使用固定 stdio fixture，首帧身份不放入环境变量；finally 始终回收子进程。
 * 2. 正常链路断言文件读取/写入、第二轮模型上下文、session 完成及 Runtime trace。
 * 3. 错误 nonce/首帧、提前断流、模型等待时取消/断连分别验证拒绝、终态和不重放。
 * 这里不提供 OS Sandbox；真实 Linux Bubblewrap 验证复用同一 Broker fixture，手动独立执行。
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { createRuntimeProbe } from "./fixtures/runtime-stream-broker.js";

async function launch(blocked = false) {
  const workspace = await temp();
  await writeFile(
    path.join(workspace, "input.txt"),
    "runtime-stream-marker\n" + "x".repeat(150000),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("tests/fixtures/agent-runtime-stream-child.ts"),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const probe = createRuntimeProbe(
    { input: child.stdout, output: child.stdin },
    {
      workspace,
      blocked,
      calls: [
        {
          name: "read_file",
          arguments: { path: "input.txt", startLine: 1, endLine: 1 },
        },
        {
          name: "edit_files",
          arguments: {
            files: [
              { path: "created.txt", create: true, content: "stream-created" },
            ],
          },
        },
      ],
    },
  );

  return {
    ...probe,
    workspace,
    child,
    exited,
    stderr: () => stderr,
    async close() {
      probe.broker.peer.end();
      child.kill();
      await exited;
    },
  };
}

it("runs real tools, model round trips and trace over the shared stdio entry", async () => {
  const probe = await launch();
  try {
    probe.sendDescriptor();
    expect(await probe.start(AbortSignal.timeout(10000))).toEqual({
      status: "completed",
    });
    await probe.broker.waitForStop(AbortSignal.timeout(1000));
    expect(probe.state.completion?.status).toBe("completed");
    expect(probe.state.modelCalls).toBe(2);
    expect(JSON.stringify(probe.state.modelInputs[1])).toContain(
      "runtime-stream-marker",
    );
    expect(
      await readFile(path.join(probe.workspace, "created.txt"), "utf8"),
    ).toBe("stream-created");
    expect(
      JSON.stringify(probe.traces.exportTask(probe.identity.taskId)),
    ).toContain("read_file.worker");
    expect(probe.state.events.some((event) => event.type === "assistant")).toBe(
      true,
    );
    probe.broker.peer.end();
    expect(await probe.exited).toBe(0);
    expect(probe.stderr()).toContain("PHASE handshake");
    expect(
      probe.state.events.find((event) => event.type === "delta")?.data,
    ).toMatchObject({ text: "IPC fixture complete" });
  } finally {
    await probe.close();
  }
});

it("rejects a wrong nonce before any model or tool work", async () => {
  const probe = await launch();
  try {
    probe.sendDescriptor(true);
    await expect(probe.start(AbortSignal.timeout(5000))).rejects.toThrow(
      "身份不匹配",
    );
    expect(await probe.exited).toBe(1);
    expect(probe.state.modelCalls).toBe(0);
  } finally {
    await probe.close();
  }
});

it.each(["malformed", "eof"])(
  "exits on %s before the descriptor",
  async (mode) => {
    const probe = await launch();
    try {
      if (mode === "malformed") {
        probe.child.stdin.write(Buffer.alloc(4, 255));
      }

      probe.child.stdin.end();
      expect(await probe.exited).toBe(1);
      expect(probe.state.modelCalls).toBe(0);
    } finally {
      await probe.close();
    }
  },
);

it.each(["cancel", "disconnect"])(
  "propagates %s while the Broker model is pending without replay",
  async (mode) => {
    const probe = await launch(true);
    try {
      probe.sendDescriptor();
      const controller = new AbortController();
      const result = probe
        .start(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
        .catch((error: unknown) => error);
      await Promise.race([
        probe.started,
        result.then(() => {
          throw new Error("Runtime exited before model started");
        }),
      ]);
      if (mode === "cancel") {
        controller.abort(new Error("fixture cancel"));
        await probe.broker.waitForStop(AbortSignal.timeout(5000));
        expect(probe.state.completion?.status).toBe("cancelled");
      } else {
        probe.broker.peer.end();
      }

      expect(await result).toBeInstanceOf(Error);
      expect(probe.state.modelAborted).toBe(true);
      expect(probe.state.modelCalls).toBe(1);
      probe.broker.peer.end();
      await probe.exited;
    } finally {
      await probe.close();
    }
  },
);

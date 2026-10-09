/**
 * 验证固定 MCP SDK 的无时限兼容点，使用官方内存 transport，不访问网络或启动子进程。
 * 1. 客户端与 Server 完成真实协议握手后延迟 tools/call 回应，虚拟推进多日验证没有隐性总时限。
 * 2. 检查 progress 正常到达，最终结果和主动取消仍沿用官方 SDK 的 request 生命周期。
 * 3. 有限握手超时继续有效；测试后关闭两端并恢复时钟，不运行 Evaluation。
 */
import { afterEach, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpClient } from "../src/mcp/unlimited-client.js";

afterEach(() => vi.useRealTimers());

it.each(["complete", "cancel"])(
  "keeps a request alive for days and supports %s",
  async (mode) => {
    vi.useFakeTimers();
    const client = createMcpClient();
    const server = new Server(
      { name: "fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    const [left, right] = InMemoryTransport.createLinkedPair();
    let finish!: () => void;
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await server.notification({
        method: "notifications/progress",
        params: {
          progressToken: request.params._meta!.progressToken!,
          progress: 1,
          message: "LATEST",
        },
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      return { content: [{ type: "text", text: "done" }] };
    });
    await Promise.all([server.connect(right), client.connect(left)]);
    const controller = new AbortController();
    const progress = vi.fn();
    let settled = false;
    const result = client.callTool({ name: "slow", arguments: {} }, undefined, {
      timeout: 0,
      signal: controller.signal,
      onprogress: progress,
    });
    const observed = result.then(
      (value) => {
        settled = true;

        return value;
      },
      (error) => {
        settled = true;

        return error as Error;
      },
    );
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ message: "LATEST" }),
    );
    if (mode === "cancel") {
      controller.abort(new Error("user cancel"));
      expect(await observed).toBeInstanceOf(Error);
    } else {
      finish();
      expect(await observed).toMatchObject({
        content: [{ type: "text", text: "done" }],
      });
    }

    await Promise.all([client.close(), server.close()]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retains a finite handshake timeout", async () => {
  vi.useFakeTimers();
  const client = createMcpClient();
  const [left] = InMemoryTransport.createLinkedPair();
  const connected = client.connect(left, { timeout: 100 });
  const failure = expect(connected).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100);
  await failure;
  await client.close();
});

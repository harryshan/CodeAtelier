/**
 * 用 SSE 告诉浏览器“这个会话有更新”，并在断线或服务关闭时清理连接。
 * createApp 注册这里的处理函数；Engine 发出 change 后，浏览器收到 refresh 再读取完整快照。
 *
 * 1. 确认会话存在，设置 SSE 响应头并将连接加入 streams。
 * 2. 建立连接时发送一次 refresh，之后只转发当前会话的变更，定时发送心跳。
 * 3. 断线时移除连接、定时器和监听；返回的清理函数供服务关闭时结束全部流。
 *
 * SSE 不保存或重放任务。断线期间发生了什么，以 Store 中的快照为准。
 */

import type { HttpServer } from "./http-server.js";
import type { ServerResponse } from "node:http";
import type { Engine } from "../agent/engine.js";
import type { Store } from "../sessions/store.js";

/** 注册会话 SSE，返回服务关闭时调用的连接清理函数。 */
export function registerSessionEvents(
  app: HttpServer,
  engine: Engine,
  store: Store,
): () => void {
  const streams = new Set<ServerResponse>();
  // SSE 只通知客户端刷新；持久化快照才是页面状态的来源。
  app.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!store.get(id)) {
      return reply.code(404).send({ error: "会话不存在" });
    }

    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = () => {
      if (!reply.raw.destroyed) {
        reply.raw.write("event: refresh\ndata: {}\n\n");
      }
    };

    const listener = (sessionId: string) => {
      if (sessionId === id) {
        send();
      }
    };

    engine.events.on("change", listener);
    send();
    const timer = setInterval(() => reply.raw.write(": keepalive\n\n"), 15000);

    reply.raw.on("close", () => {
      streams.delete(reply.raw);
      clearInterval(timer);
      engine.events.off("change", listener);
    });
  });

  return () => {
    for (const stream of streams) {
      stream.end();
    }
  };
}

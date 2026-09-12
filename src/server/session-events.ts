/**
 * 文件作用：通过 SSE 通知浏览器刷新指定会话，并管理流连接生命周期。
 * 代码结构：registerSessionEvents 注册会话事件路由、变更监听与心跳，处理断连清理并返回服务关闭时的统一清理入口。
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

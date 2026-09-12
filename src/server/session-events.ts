/**
 * 文件作用：通过 SSE 通知浏览器刷新指定会话，并管理流连接生命周期。
 *
 * 模块协作与输入输出：
 * 由 createApp 注册，订阅 Engine 的 change 通知；客户端收到 refresh 后重新读取会话快照。
 *
 * 代码结构与执行顺序：
 * 1. 验证会话存在后接管 HTTP 响应，将连接放入 streams 集合并设置 SSE 响应头。
 * 2. 仅匹配当前 sessionId 的变更才发送 refresh，连接初建也发送一次，并定期写心跳。
 * 3. 连接关闭时删除集合条目、定时器与事件监听；返回函数供服务统一结束所有流。
 *
 * 关键约束：
 * SSE 不传完整业务状态，也不重放任务；断线期间的真实结果从 Store 快照恢复。
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

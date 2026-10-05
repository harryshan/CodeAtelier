/**
 * 为 Web 阅读器提供数据库历史的只读接口，由 createApp 在共用安全 hooks 后注册。
 * 输入仅为会话/任务 ID，输出轻量 Task 列表或单个 TaskReplayCase；复用现有 Store 分片与 legacy 重建。
 *
 * 1. registerReplayRoutes 注册任务目录及任务详情，查询前验证任务确实属于路径中的会话。
 * 2. read 包装查询生命周期，记录 requestId、耗时和结果，不记录 prompt、响应正文或数据库路径。
 * 3. 查询失败返回通用错误，避免把损坏的 JSON/SQL 材料透出；缺失或跨会话任务统一 404。
 *
 * 不接受 SQL、数据库路径或导出目录，不落盘、不启动 Engine、不恢复或重放任务。
 * 认证、来源检查及 no-store 沿用应用 hooks；运行中记录只是当前已提交内容，刷新须由用户触发。
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { HttpServer } from "./http-server.js";
import type { Logger } from "pino";
import type { Store } from "../sessions/store.js";

export function registerReplayRoutes(
  app: HttpServer,
  store: Store,
  log: Logger,
) {
  function read(
    req: FastifyRequest,
    reply: FastifyReply,
    query: () => unknown,
  ) {
    const started = performance.now();
    const context = { module: "server", requestId: req.id };
    log.debug({ ...context, event: "replay.read_started" });
    try {
      const result = query();
      log.debug({
        ...context,
        event: "replay.read_finished",
        statusCode: reply.statusCode,
        durationMs: performance.now() - started,
      });

      return result;
    } catch {
      log.warn({
        ...context,
        event: "replay.read_failed",
        durationMs: performance.now() - started,
      });

      return reply
        .code(500)
        .send({ error: "无法读取已保存记录，请查看服务日志并稍后重试。" });
    }
  }

  app.get("/api/sessions/:id/tasks", (req, reply) =>
    read(req, reply, () => {
      const { id } = req.params as { id: string };
      if (!store.get(id)) {
        return reply.code(404).send({ error: "会话不存在" });
      }

      return store.tasks(id);
    }),
  );
  app.get("/api/sessions/:id/tasks/:taskId/replay", (req, reply) =>
    read(req, reply, () => {
      const { id, taskId } = req.params as { id: string; taskId: string };
      if (!store.get(id) || store.task(taskId)?.sessionId !== id) {
        return reply.code(404).send({ error: "会话或任务不存在" });
      }

      const value = store.replayCase(taskId);
      if (!value) {
        return reply.code(404).send({ error: "会话或任务不存在" });
      }

      return value;
    }),
  );
}

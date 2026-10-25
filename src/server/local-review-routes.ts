/**
 * 已有 Local 会话的单文件只读检查 HTTP 入口，由 createApp 注册。
 * 1. 沿用全局来源/密码/session/CSRF/no-store；只接收会话 ID 和相对路径，不接收控制目录。
 * 2. ready 清单之外拒绝，最终互斥与身份复核交给 LocalOverlayService；无需启动 Runtime。
 * 3. 断开连接取消检查，错误只返回受控提示，不暴露磁盘路径/SQLite 原始错误或记录正文。
 * 不执行冲突解决或发布；生命周期 tracing 由服务负责，路由不向历史 task 追加事件。
 */
import type { HttpServer } from "./http-server.js";
import { z } from "zod";
import type { Engine } from "../agent/engine.js";
import type { AsyncStore } from "../sessions/async-store.js";
import { PublishError } from "../local-overlays/publication/merge.js";

export function registerLocalReviewRoutes(
  app: HttpServer,
  store: AsyncStore,
  engine: Engine,
) {
  app.post("/api/sessions/:id/local-review", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { path } = z
      .object({ path: z.string().min(1).max(1024) })
      .strict()
      .parse(request.body);
    const session = await store.get(id);
    if (!session) {
      return reply.code(404).send({ error: "会话不存在。" });
    }

    const info = (await engine.localOverlays.describe(session)).localOverlay;
    if (!info) {
      return reply.code(404).send({ error: "此会话没有隔离 Local 私有视图。" });
    }

    if (info.state !== "ready") {
      return reply
        .code(409)
        .send({ error: "请等待任务正常结束；状态未知的私有视图暂不能检查。" });
    }

    const abort = new AbortController();
    const disconnected = () => abort.abort();
    reply.raw.once("close", disconnected);
    try {
      return await engine.localOverlays.review(
        session.workspace,
        session.id,
        path,
        abort.signal,
      );
    } catch (error) {
      const missing =
        error instanceof PublishError && error.code === "NATIVE_CHANGE_MISSING";

      return reply.code(409).send({
        error: missing
          ? "该路径没有可检查的封存私有修改，请核对路径和大小写。"
          : "当前无法检查此文件。仅支持正常结束视图中已捕获的小型普通文件；私有修改保持不变。",
      });
    } finally {
      reply.raw.off("close", disconnected);
    }
  });
}

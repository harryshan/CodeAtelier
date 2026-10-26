/**
 * 已有 Local 会话的文件检查与新对话继续 HTTP 入口，由 createApp 注册。
 * 1. 沿用全局来源/密码/session/CSRF/no-store；只接收会话 ID 和相对路径，不接收控制目录。
 * 2. 私有内容检查只接受 ready 清单，来源事故另由原生租约证明排空；互斥/身份复核交给 Service，无需启动 Runtime。
 * 3. 断开连接取消检查，错误只返回受控提示，不暴露磁盘路径/SQLite 原始错误或记录正文。
 * 不执行冲突解决或发布；生命周期 tracing 由服务负责，路由不向历史 task 追加事件。
 * 4. local-resolution 显式建立新 Local 对话及已审核参考，不自动启动任务；固定 UUID 重试复用创建结果，沿用创建能力门禁。
 * 5. path 保留旧单文件响应；paths 使用整组版本，最多 100 项，任一材料失败即拒绝整组。
 * 6. publication-review/accept 只接收空请求或检查 token；从会话定位事故，断线取消，不启动任务或恢复私有视图。
 */
import type { HttpServer } from "./http-server.js";
import { z } from "zod";
import type { Engine } from "../agent/engine.js";
import type { AsyncStore } from "../sessions/async-store.js";
import { PublishError } from "../local-overlays/publication/merge.js";

const relativePath = z.string().min(1).max(1024);
const selectionSchema = z.union([
  z.object({ path: relativePath }).strict(),
  z.object({ paths: z.array(relativePath).min(1).max(100) }).strict(),
]);
const continuationFields = {
  id: z.uuid(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
};
const continuationSchema = z.union([
  z.object({ ...continuationFields, path: relativePath }).strict(),
  z
    .object({
      ...continuationFields,
      paths: z.array(relativePath).min(1).max(100),
    })
    .strict(),
]);

export function registerLocalReviewRoutes(
  app: HttpServer,
  store: AsyncStore,
  engine: Engine,
) {
  for (const action of ["review", "accept"] as const) {
    app.post(
      `/api/sessions/:id/local-publication-${action}`,
      async (request, reply) => {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        const input =
          action === "accept"
            ? z
                .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
                .strict()
                .parse(request.body)
            : z.object({}).strict().parse(request.body);
        const session = await store.get(id);
        if (!session) {
          return reply.code(404).send({ error: "会话不存在。" });
        }

        const abort = new AbortController();
        const disconnected = () => abort.abort();
        reply.raw.once("close", disconnected);
        try {
          return await engine.localOverlays.publicationRecovery(
            session.workspace,
            session.id,
            "token" in input ? input.token : undefined,
            abort.signal,
          );
        } catch {
          return reply.code(409).send({
            error:
              action === "accept"
                ? "解锁结果未确认或检查已过期。可重试同一接受请求；重新检查不会回滚已记录的决定。原私有修改保留。"
                : "发布现场暂不能核查：任务可能仍活动、记录不完整、内容超过 16 MiB 或原生执行证明不可用。保留现场，不解除锁。",
          });
        } finally {
          reply.raw.off("close", disconnected);
        }
      },
    );
  }

  app.post("/api/sessions/:id/local-resolution", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const input = continuationSchema.parse(request.body);
    const parent = await store.get(id);
    if (!parent) {
      return reply.code(404).send({ error: "会话不存在。" });
    }

    const availability = engine.localOverlayCreation;
    if (!availability.enabled) {
      return reply.code(409).send({ error: availability.reason });
    }

    try {
      const session = await engine.localOverlays.continueResolution(
        { ...input, workspace: parent.workspace, sessionId: parent.id },
        async (workspace) => {
          const existing = (await store.list()).find(
            (entry) => entry.workspace === workspace,
          );

          return existing ?? store.createAsync(workspace);
        },
      );

      return engine.describeSession(session);
    } catch {
      return reply.code(409).send({
        error:
          "创建未确认或检查材料已改变。可重试同一请求；重新检查不会删除可能已创建的对话。原私有修改已保留。",
      });
    }
  });
  app.post("/api/sessions/:id/local-review", async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const input = selectionSchema.parse(request.body);
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
      if ("paths" in input) {
        return await engine.localOverlays.reviewBatch(
          session.workspace,
          session.id,
          input.paths,
          abort.signal,
        );
      }

      return await engine.localOverlays.review(
        session.workspace,
        session.id,
        input.path,
        abort.signal,
      );
    } catch (error) {
      const missing =
        error instanceof PublishError && error.code === "NATIVE_CHANGE_MISSING";

      return reply.code(409).send({
        error: missing
          ? "该路径没有可检查的封存私有修改，请核对路径和大小写。"
          : "当前无法检查所选文件。仅支持正常结束视图中已捕获的小型普通文件，最多 100 项、内容与预览合计 16 MiB；私有修改保持不变。",
      });
    } finally {
      reply.raw.off("close", disconnected);
    }
  });
}

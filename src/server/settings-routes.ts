/**
 * 设置 HTTP 接口，createApp 在统一来源、门禁和写 token 校验之后注册。
 * 1. GET 返回普通运行视图与独立的无凭据编辑视图；PATCH 接受 revision 局部更新。
 * 2. validate 不写盘，reload 显式采用磁盘配置；成功后只应用日志/调度及下一任务配置。
 * 3. 每次操作记录 requestId、耗时和终态，不记录请求、字段值或底层异常。
 * 旧 PUT 仅供未迁移配置使用，仍保留旧活动任务保护；迁移后明确退役。
 */
import { z } from "zod";
import type { HttpServer } from "./http-server.js";
import type { Config } from "../config/config.js";
import type { Engine } from "../agent/engine.js";
import { SettingsConflict } from "../config/settings-store.js";

export function registerSettingsRoutes(
  app: HttpServer,
  config: Config,
  engine: Engine,
) {
  const view = async () => ({
    ...config.publicValue(),
    sandbox: engine.sandbox.status,
    editor: await config.editorValue(),
  });
  const apply = async () => {
    app.log.level = config.settings.logLevel;
    engine.sandboxLog.level = config.settings.logLevel;
    await engine.settingsChanged();
  };

  app.get("/api/settings", view);
  for (const action of ["save", "validate", "reload"] as const) {
    app.route({
      method: action === "save" ? "PATCH" : "POST",
      url: action === "save" ? "/api/settings" : `/api/settings/${action}`,
      handler: async (request, reply) => {
        const started = performance.now();
        const context = { module: "settings", requestId: request.id, action };
        app.log.info({ ...context, event: "settings.started" });
        try {
          if (action === "validate") {
            const result = await config.validateDocument(request.body);
            app.log.info({
              ...context,
              event: "settings.finished",
              durationMs: performance.now() - started,
            });

            return result;
          }

          if (action === "reload") {
            const input = z
              .object({
                expectedRevision: z.string(),
                confirm: z.literal(true),
              })
              .strict()
              .safeParse(request.body);
            if (!input.success) {
              throw new Error("重新读取配置需要 revision 和明确确认。");
            }

            await config.reloadDocument(input.data.expectedRevision);
          } else {
            await config.updateDocument(request.body);
          }

          await apply();
          app.log.info({
            ...context,
            event: "settings.finished",
            durationMs: performance.now() - started,
          });

          return await view();
        } catch (error) {
          const conflict = error instanceof SettingsConflict;
          app.log.warn({
            ...context,
            event: "settings.failed",
            conflict,
            durationMs: performance.now() - started,
          });

          return reply.code(conflict ? 409 : 400).send({
            error:
              error instanceof Error
                ? error.message
                : "配置操作失败；请重新读取确认状态。",
          });
        }
      },
    });
  }

  app.put("/api/settings", async (request) => {
    if (await engine.hasActiveTasks()) {
      throw new Error("旧设置接口请等待任务结束；新版设置页支持运行期间保存。");
    }

    config.update(request.body);
    await apply();

    return { ...config.publicValue(), sandbox: engine.sandbox.status };
  });
}

/**
 * 创建 Fastify 应用，接入会话、任务、设置、审批和历史接口；默认仅本机访问，也可由入口显式开放局域网监听。
 * 服务入口和测试服务都调用 createApp，得到 app、engine、store 及 shutdown。
 *
 * 1. 创建 Fastify、Store 和 Engine；若启用 Windows Sandbox，在监听前排空上次服务遗留的账户进程和 ACL journal。
 * 2. 先按监听范围注册来源与凭据检查、关闭/受监督重载接口和错误处理，再注册 bootstrap、设置接口。
 * 3. bootstrap 报告与 Engine 一致的 subagent 发布门禁；会话路由支持显式 Worktree 创建与幂等绑定、列表/分页快照补充来源；任务路由仍独立检查启动、恢复、取消和 trace/审批。
 * 4. 注册复用 Store 的只读任务阅读接口，接入 SSE，并提供构建后的网页；没有前端产物时显示开发提示。
 * 5. preClose 中断任务并结束 SSE，onClose 关闭数据库。
 *
 * 关闭时要先确认任务已经中断，再结束服务。页面从保存的会话快照读取状态，任务循环由 Engine 执行。
 * trace/live 在相同鉴权下返回 partial 内存快照或持久检查点，no-store；终态下载只读归档。
 * 两个入口统一经 simple-view 输出英文简洁时间线，不提供详细切换、不重写原始诊断文件。
 */

import Fastify, { LogController } from "fastify";
import staticPlugin from "@fastify/static";
import {
  registerLocalSecurity,
  validatePasswordAccessConfiguration,
} from "./local-security.js";
import { registerSessionEvents } from "./session-events.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerReplayRoutes } from "./replay-routes.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { Config } from "../config/config.js";
import { AsyncStore } from "../sessions/async-store.js";
import { Engine } from "../agent/engine.js";
import { SUBAGENT_PUBLIC_READY } from "../agent/subagent-readiness.js";
import type { ModelProviderFactory } from "../providers/model-provider.js";
import { workspacePath } from "../tools/paths.js";
import { simplifyTrace } from "../tracing/simple-view.js";

export async function createApp(
  config: Config,
  log: Logger,
  providerFactory?: ModelProviderFactory,
  onStopped?: () => void,
  onReload?: () => void,
  allowNetworkAccess = false,
) {
  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1048576,
  });
  const access = config.server
    ? {
        enabled: config.server.passwordEnabled,
        password: "",
        passwordHash: config.server.passwordHash,
      }
    : undefined;
  validatePasswordAccessConfiguration(access);

  const store = await AsyncStore.open(
    path.join(config.directory, "history.sqlite"),
  );
  const engine = new Engine(store, config, log, providerFactory);
  store.startMaintenance(log);
  await engine.sandbox.recoverAtStartup();
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  // Web 请求和进程信号共用这一个关闭 Promise，避免重复释放资源。
  const shutdown = (reason: "shutdown" | "reload" = "shutdown") => {
    stopping = true;
    shutdownPromise ??= app.close().then(() => {
      log.info({ event: "server.stopped", module: "server", reason });
      if (reason === "reload") {
        onReload?.();
      } else {
        onStopped?.();
      }
    });

    return shutdownPromise;
  };

  const token = registerLocalSecurity(app, allowNetworkAccess, access);

  app.addHook("preHandler", async (req, reply) => {
    if (
      stopping &&
      !["/api/server/shutdown", "/api/server/reload"].includes(req.url)
    ) {
      return reply.code(503).send({ error: "服务正在关闭。" });
    }
  });
  app.post("/api/server/shutdown", async (req, reply) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    stopping = true;
    log.info({ event: "server.stopping", module: "server", source: "web" });
    const finish = () => {
      setImmediate(
        () =>
          void shutdown().catch((error) => {
            log.error({
              event: "server.shutdown_failed",
              module: "server",
              err: error,
            });
          }),
      );
    };

    // 即使浏览器没等到响应就断开，也要继续关闭服务。
    reply.raw.once("finish", finish);
    reply.raw.once("close", finish);
    await engine.close();

    return { ok: true };
  });
  app.post("/api/server/reload", async (req, reply) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    if (!onReload) {
      return reply.code(409).send({
        error: "当前启动方式不支持服务重载，请在终端重新启动服务。",
      });
    }

    stopping = true;
    log.info({ event: "server.reloading", module: "server", source: "web" });
    const finish = () => {
      setImmediate(
        () =>
          void shutdown("reload").catch((error) => {
            log.error({
              event: "server.reload_failed",
              module: "server",
              err: error,
            });
          }),
      );
    };

    // 浏览器收到确认即可等待替代进程；即使响应连接提前结束，也必须继续释放旧端口。
    reply.raw.once("finish", finish);
    reply.raw.once("close", finish);
    await engine.close();

    return { ok: true };
  });
  app.setErrorHandler((error, req, reply) => {
    const validation = error instanceof z.ZodError;

    log.warn({
      event: "request.failed",
      module: "server",
      method: req.method,
      err: error,
    });
    reply.code(validation ? 400 : 409).send({
      error: validation
        ? "请求参数无效。"
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "请求失败",
    });
  });
  app.get("/api/bootstrap", async (_req, reply) => {
    reply.header(
      "Set-Cookie",
      `ca_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return {
      token,
      ...config.publicValue(),
      sandbox: engine.sandbox.status,
      subagentsAvailable: SUBAGENT_PUBLIC_READY,
      active: engine.activeTasks,
    };
  });
  registerSettingsRoutes(app, config, engine);
  registerReplayRoutes(app, store, log);
  app.get("/api/sessions", async () =>
    Promise.all(
      (await store.list()).map((session) => engine.worktrees.describe(session)),
    ),
  );
  app.post("/api/worktrees/inspect", async (req) => {
    const data = z
      .object({ workspace: z.string().min(1) })
      .strict()
      .parse(req.body);
    const repository = await engine.worktrees.inspect(
      await workspacePath(data.workspace),
    );

    return { branches: repository.branches };
  });
  app.post("/api/sessions", async (req) => {
    const data = z
      .object({
        workspace: z.string().min(1),
        worktree: z
          .object({ id: z.uuid(), baseRef: z.string().min(1).max(1024) })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);

    const workspace = await workspacePath(data.workspace);
    if (data.worktree) {
      return engine.worktrees.create(
        { ...data.worktree, workspace },
        async (checkout) => {
          const existing = (await store.list()).find(
            (session) => session.workspace === checkout,
          );

          return existing ?? store.createAsync(checkout);
        },
      );
    }

    await engine.worktrees.validate(workspace);

    return engine.worktrees.describe(await store.createAsync(workspace));
  });
  app.get("/api/sessions/:id/traces", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) {
      return reply.code(404).send({ error: "会话不存在" });
    }

    return { taskIds: await engine.traceArchive.taskIds(session.id) };
  });
  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const options = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        before: z.coerce.number().int().positive().optional(),
        highWater: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    if (!(await store.get(id))) {
      return reply.code(404).send({ error: "会话不存在" });
    }

    if (options.before !== undefined) {
      const snapshot = await store.snapshotPage(id, options);

      return {
        ...snapshot,
        session: snapshot.session
          ? await engine.worktrees.describe(snapshot.session)
          : undefined,
        approvals: engine.approvals.list(id),
      };
    }

    return engine.snapshot(id, options.after);
  });
  app.get("/api/sessions/:id/event-body/:eventId", async (req, reply) => {
    const { id, eventId } = z
      .object({ id: z.string(), eventId: z.coerce.number().int().positive() })
      .parse(req.params);
    const { offset } = z
      .object({ offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    if (!(await store.get(id))) {
      return reply.code(404).send({ error: "会话不存在" });
    }

    return store.eventBody(id, eventId, offset);
  });
  app.post("/api/sessions/:id/tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { prompt, subagentsEnabled } = z
      .object({
        prompt: z.string().trim().min(1).max(40000),
        subagentsEnabled: z.boolean().default(false),
      })
      .parse(req.body);

    // 在主从 loop、持久化和 Sandbox 均可用之前，不接受会默默退化为单 agent 的请求。
    if (subagentsEnabled && !SUBAGENT_PUBLIC_READY) {
      return reply
        .code(409)
        .send({ error: "subagent 尚未就绪，不能启用本次任务。" });
    }

    return engine.startAsync(id, prompt, { subagentsEnabled });
  });
  app.post("/api/tasks/:id/resume", async (req) => {
    const { instruction } = z
      .object({ instruction: z.string().max(40000).default("") })
      .parse(req.body);

    return engine.resumeAsync((req.params as { id: string }).id, instruction);
  });
  app.post("/api/tasks/:id/cancel", async (req) => {
    await engine.cancelAsync((req.params as { id: string }).id);

    return { ok: true };
  });
  app.get("/api/tasks/:id/trace/live", async (req, reply) => {
    const task = await store.task((req.params as { id: string }).id);
    if (!task) {
      return reply.code(404).send({ error: "任务不存在" });
    }

    const trace = await engine.liveTrace(task);
    if (!trace) {
      return reply
        .code(404)
        .send({ error: "该任务没有运行中 trace 或检查点。" });
    }

    return reply
      .header("Cache-Control", "no-store")
      .type("application/json")
      .send(simplifyTrace(trace));
  });
  app.get("/api/tasks/:id/trace", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = await store.task(id);
    if (!task) {
      return reply.code(404).send({ error: "任务不存在" });
    }

    const trace = await engine.savedTrace(task);
    if (!trace) {
      return reply.code(404).send({ error: "该任务尚未生成 trace。" });
    }

    reply.header(
      "Content-Disposition",
      `attachment; filename="codeatelier-${id}.json"`,
    );

    return reply.type("application/json").send(simplifyTrace(trace));
  });
  app.post("/api/approvals/:id", async (req) => {
    const { decision } = z
      .object({ decision: z.enum(["once", "session", "deny"]) })
      .parse(req.body);

    engine.approvals.decide((req.params as { id: string }).id, decision);

    return { ok: true };
  });
  const closeSessionStreams = registerSessionEvents(app, engine, store);

  const web = path.resolve("dist/web");

  if (existsSync(web)) {
    await app.register(staticPlugin, { root: web, prefix: "/" });
  } else {
    app.get("/", async (_req, reply) =>
      reply
        .type("text/html")
        .send(
          "<h1>CodeAtelier</h1><p>开发界面：运行 pnpm dev:web，打开 http://127.0.0.1:5173</p>",
        ),
    );
  }

  app.addHook("preClose", async () => {
    stopping = true;
    await engine.close();
    closeSessionStreams();
  });
  app.addHook("onClose", async () => {
    await engine.close();
    await store.closeAsync();
  });

  return { app, engine, store, shutdown };
}

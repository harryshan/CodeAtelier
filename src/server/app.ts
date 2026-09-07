import Fastify, { LogController } from "fastify";
import staticPlugin from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { Config } from "../config/settings.js";
import { Store } from "../sessions/store.js";
import { Engine } from "../agent/engine.js";
import type { ModelProvider } from "../providers/responses.js";
import { workspacePath } from "../tools/paths.js";
export async function createApp(
  config: Config,
  log: Logger,
  providerFactory?: () => ModelProvider,
  onStopped?: () => void,
) {
  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1048576,
  });
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const engine = new Engine(store, config, log, providerFactory);
  const streams = new Set<import("node:http").ServerResponse>();
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    stopping = true;
    shutdownPromise ??= app.close().then(() => {
      log.info({ event: "server.stopped", module: "server" });
      onStopped?.();
    });
    return shutdownPromise;
  };
  const token = randomBytes(32).toString("hex");
  const compare = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: "仅允许本机访问。" });
    const origin = req.headers.origin;
    if (origin) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return reply.code(403).send({ error: "无效来源" });
      }
      const allowed =
        url.host === host ||
        (process.env.NODE_ENV !== "production" &&
          ["127.0.0.1:5173", "localhost:5173"].includes(url.host));
      if (!allowed || !["http:", "https:"].includes(url.protocol))
        return reply.code(403).send({ error: "拒绝跨站请求。" });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/bootstrap")) {
      const cookie =
        (req.headers.cookie || "")
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("ca_session="))
          ?.slice(11) || "";
      if (!compare(cookie))
        return reply.code(401).send({ error: "请刷新页面建立本机会话。" });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !compare(String(req.headers["x-codeatelier-token"] || ""))
      )
        return reply.code(403).send({ error: "会话校验失败，请刷新页面。" });
    }
  });
  app.addHook("preHandler", async (req, reply) => {
    if (stopping && req.url !== "/api/server/shutdown")
      return reply.code(503).send({ error: "服务正在关闭。" });
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
              errorName: error?.name,
            });
          }),
      );
    };
    // Close even when the requester disconnects before receiving the acknowledgement.
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
      errorName: error instanceof Error ? error.name : "Unknown",
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
      active: engine.active?.task || null,
    };
  });
  app.get("/api/settings", async () => config.publicValue());
  app.put("/api/settings", async (req) => {
    if (engine.active) throw new Error("请等待当前任务结束后再修改设置。");
    config.update(req.body);
    log.level = config.settings.logLevel;
    return config.publicValue();
  });
  app.get("/api/sessions", async () => store.list());
  app.post("/api/sessions", async (req) => {
    const data = z
      .object({
        workspace: z.string().min(1),
        title: z.string().min(1).max(100),
      })
      .parse(req.body);
    return store.create(await workspacePath(data.workspace), data.title);
  });
  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.get(id)) return reply.code(404).send({ error: "会话不存在" });
    return engine.snapshot(id);
  });
  app.post("/api/sessions/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const { prompt } = z
      .object({ prompt: z.string().trim().min(1).max(40000) })
      .parse(req.body);
    return engine.start(id, prompt);
  });
  app.post("/api/tasks/:id/resume", async (req) => {
    const { instruction } = z
      .object({ instruction: z.string().max(40000).default("") })
      .parse(req.body);
    return engine.resume((req.params as { id: string }).id, instruction);
  });
  app.post("/api/tasks/:id/cancel", async (req) => {
    engine.cancel((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/approvals/:id", async (req) => {
    const { decision } = z
      .object({ decision: z.enum(["once", "session", "deny"]) })
      .parse(req.body);
    engine.approvals.decide((req.params as { id: string }).id, decision);
    return { ok: true };
  });
  app.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.get(id)) return reply.code(404).send({ error: "会话不存在" });
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = () => {
      if (!reply.raw.destroyed) reply.raw.write("event: refresh\ndata: {}\n\n");
    };
    const listener = (sessionId: string) => {
      if (sessionId === id) send();
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
  const web = path.resolve("dist/web");
  if (existsSync(web))
    await app.register(staticPlugin, { root: web, prefix: "/" });
  else
    app.get("/", async (_req, reply) =>
      reply
        .type("text/html")
        .send(
          "<h1>CodeAtelier</h1><p>开发界面：运行 pnpm dev:web，打开 http://127.0.0.1:5173</p>",
        ),
    );
  app.addHook("preClose", async () => {
    stopping = true;
    await engine.close();
    for (const stream of streams) stream.end();
  });
  app.addHook("onClose", async () => {
    await engine.close();
    store.close();
  });
  return { app, engine, store, shutdown };
}

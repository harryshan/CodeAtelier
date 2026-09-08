import type { HttpServer } from "./http-server.js";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** 注册本机来源与写请求身份校验，返回 bootstrap 使用的会话凭据。 */
export function registerLocalSecurity(app: HttpServer): string {
  const token = randomBytes(32).toString("hex");
  const compare = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(token);

    return a.length === b.length && timingSafeEqual(a, b);
  };

  // 来源校验先于业务路由执行；写操作还需验证本机会话 token。
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host || "";

    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
      return reply.code(403).send({ error: "仅允许本机访问。" });
    }

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

      if (!allowed || !["http:", "https:"].includes(url.protocol)) {
        return reply.code(403).send({ error: "拒绝跨站请求。" });
      }
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

      if (!compare(cookie)) {
        return reply.code(401).send({ error: "请刷新页面建立本机会话。" });
      }

      if (
        !["GET", "HEAD"].includes(req.method) &&
        !compare(String(req.headers["x-codeatelier-token"] || ""))
      ) {
        return reply.code(403).send({ error: "会话校验失败，请刷新页面。" });
      }
    }
  });

  return token;
}

/**
 * 在业务路由执行前检查请求来源、可选访问密码和本机会话凭据，防止未验证设备或其他网站借本机/受信任局域网服务发起操作。
 * createApp 按实际监听范围调用 registerLocalSecurity；本模块自行从启动环境读取访问门禁配置，并生成 bootstrap 使用的令牌。
 *
 * 1. passwordAccess 严格解析开关和密码；启用时缺少密码会阻止服务启动，避免误以为页面受保护。
 * 2. 生成随机令牌；比较函数先核对长度，再用 timingSafeEqual 比较访问 cookie、本机 cookie 或提交的密码。
 * 3. 注册不需要既有会话的访问状态和登录路由；成功登录只写入 HttpOnly 的 ca_access cookie，密码不会进入浏览器配置或日志。
 * 4. onRequest 在默认回环模式拒绝非本机 Host；显式开放局域网时保留同源 Origin 校验，但接受 LAN 客户端的 Host。
 * 5. 启用门禁后，除访问状态和登录外的 API 都要求 ca_access；除 bootstrap 外仍要求 ca_session，写请求还必须携带 x-codeatelier-token。
 *
 * 访问密码是可选的单一服务实例门禁，不提供用户账户、权限分级或公网部署能力。服务重启后访问与本机会话令牌均会轮换，浏览器需要重新验证；通过 HTTP 校验后，工具执行仍须遵守审批规则。
 */

import type { HttpServer } from "./http-server.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

type PasswordAccess = {
  enabled: boolean;
  password: string;
};

function passwordAccess(): PasswordAccess {
  const enabled = process.env.CODEATELIER_WEB_PASSWORD_ENABLED || "false";
  const password = process.env.CODEATELIER_WEB_PASSWORD ?? "";

  if (enabled !== "true" && enabled !== "false") {
    throw new Error(
      "CODEATELIER_WEB_PASSWORD_ENABLED must be exactly true or false.",
    );
  }

  if (enabled === "true" && !password) {
    throw new Error(
      "Set CODEATELIER_WEB_PASSWORD when CODEATELIER_WEB_PASSWORD_ENABLED=true.",
    );
  }

  return { enabled: enabled === "true", password };
}

/** 在创建 SQLite 等后续资源前校验门禁环境，避免启动失败留下未关闭句柄。 */
export function validatePasswordAccessConfiguration(): void {
  passwordAccess();
}

function cookieValue(header: string | undefined, name: string): string {
  return (
    header
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}

function hostname(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

/** 注册与监听范围匹配的来源和写请求校验，返回 bootstrap 使用的会话凭据。 */
export function registerLocalSecurity(
  app: HttpServer,
  allowNetworkAccess = false,
): string {
  const access = passwordAccess();
  const accessToken = access.enabled ? randomBytes(32).toString("hex") : "";
  const token = randomBytes(32).toString("hex");
  const compare = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(token);

    return a.length === b.length && timingSafeEqual(a, b);
  };

  const compareAccess = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(accessToken);

    return a.length === b.length && timingSafeEqual(a, b);
  };

  const comparePassword = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(access.password);

    return a.length === b.length && timingSafeEqual(a, b);
  };

  const hasAccess = (cookie: string | undefined) =>
    !access.enabled || compareAccess(cookieValue(cookie, "ca_access"));

  app.get("/api/access/status", async (req) => ({
    enabled: access.enabled,
    authenticated: hasAccess(req.headers.cookie),
  }));
  app.post("/api/access/login", async (req, reply) => {
    const { password } = z
      .object({ password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body);

    if (!access.enabled) {
      return reply.code(409).send({ error: "访问密码验证未启用。" });
    }

    if (!comparePassword(password)) {
      app.log.warn({ event: "access.password_rejected", module: "server" });

      return reply.code(401).send({ error: "密码不正确。" });
    }

    reply.header(
      "Set-Cookie",
      `ca_access=${accessToken}; HttpOnly; SameSite=Strict; Path=/`,
    );
    app.log.info({ event: "access.password_accepted", module: "server" });

    return { ok: true };
  });

  // 来源校验先于业务路由执行；写操作还需验证本机会话 token。
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host || "";

    const hostName = hostname(host);

    if (
      !hostName ||
      (!allowNetworkAccess &&
        !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
    ) {
      return reply.code(403).send({ error: "服务仅允许本机回环访问。" });
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
          url.port === "5173" &&
          url.hostname === hostName);

      if (!allowed || !["http:", "https:"].includes(url.protocol)) {
        return reply.code(403).send({ error: "拒绝跨站请求。" });
      }
    }

    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const pathname = req.url.split("?", 1)[0];
    const publicAccessRoute =
      pathname === "/api/access/status" || pathname === "/api/access/login";

    if (
      pathname.startsWith("/api/") &&
      access.enabled &&
      !publicAccessRoute &&
      !hasAccess(req.headers.cookie)
    ) {
      return reply.code(401).send({ error: "请输入访问密码后继续。" });
    }

    if (
      pathname.startsWith("/api/") &&
      pathname !== "/api/bootstrap" &&
      !publicAccessRoute
    ) {
      const cookie = cookieValue(req.headers.cookie, "ca_session");

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

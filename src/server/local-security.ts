/**
 * 在业务路由执行前检查请求来源和会话凭据，防止其他网站借本机或受信任局域网服务发起操作。
 * createApp 按实际监听范围调用注册函数，得到 bootstrap 要发给浏览器的令牌。
 *
 * 1. 生成随机令牌；compare 先核对长度，再用 timingSafeEqual 比较。
 * 2. onRequest 在默认回环模式拒绝非本机 Host；显式开放局域网时保留同源 Origin 校验，但接受 LAN 客户端的 Host。
 * 3. 除 bootstrap 外，API 都要求 ca_session Cookie；写请求还必须携带 x-codeatelier-token。
 * 4. 设置 no-store 和 nosniff 响应头，不合法的请求直接返回 401 或 403。
 *
 * Cookie 和 token 是浏览器会话/跨站请求防护，而非局域网用户认证；开放局域网仅适用于可信网络。服务重启后令牌会变，浏览器需要重新 bootstrap。通过 HTTP 校验后，工具执行仍须遵守审批规则。
 */

import type { HttpServer } from "./http-server.js";
import { randomBytes, timingSafeEqual } from "node:crypto";

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
  const token = randomBytes(32).toString("hex");
  const compare = (value: string) => {
    const a = Buffer.from(value);
    const b = Buffer.from(token);

    return a.length === b.length && timingSafeEqual(a, b);
  };

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

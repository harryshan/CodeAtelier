/**
 * 为 local-security 和 session-events 提供与 createApp 一致的 HTTP 服务类型。
 *
 * 1. 引入 Node HTTP、Fastify 和 Pino 的类型。
 * 2. 将它们组合为 HttpServer，供路由注册函数声明参数使用。
 *
 * 这里只导出类型，不创建服务器或监听端口。
 */

import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Logger } from "pino";

/** 本机 HTTP 服务的统一类型，保留项目使用的 Pino 日志实例。 */
export type HttpServer = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  Logger
>;

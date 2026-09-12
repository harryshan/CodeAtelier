/**
 * 文件作用：统一服务模块使用的 Fastify HTTP 实例类型。
 * 代码结构：导入 Node HTTP、Fastify 和 Pino 类型，再导出与应用日志实例一致的 HttpServer 别名。
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

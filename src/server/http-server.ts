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

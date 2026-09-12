/**
 * 文件作用：统一服务模块使用的 Fastify HTTP 实例类型。
 *
 * 模块协作与输入输出：
 * 让 local-security 与 session-events 使用和 createApp 相容的服务类型，不重复声明泛型组合。
 *
 * 代码结构与执行顺序：
 * 1. 导入 Node HTTP 请求/响应、FastifyInstance 和 Pino Logger 类型。
 * 2. HttpServer 将这些类型组合成统一导出，供独立注册函数签名使用。
 *
 * 关键约束：
 * 本文件仅提供编译期类型，不创建服务器、不监听端口，也不引入运行时状态。
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

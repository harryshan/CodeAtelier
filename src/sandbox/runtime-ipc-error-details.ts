/**
 * 为 RuntimeIpcPeer 生成可定位且有界的错误文字，不读取请求正文或执行任何 I/O。
 * Broker 注入当前密钥用于脱敏；Runtime 使用相同函数处理不含模型密钥的本地错误。
 *
 * 1. ipcErrorText 先脱敏再截断，供错误消息、错误码和关联 ID 共用。
 * 2. ipcSchemaDetails 只提取 Zod 校验字段及代码，不输出字段值、union 原始数据或未知键。
 * 3. ipcFailureDetails 提取 message/code 和最多三层 cause；不序列化任意异常对象、响应正文或堆栈。
 */

import { ZodError } from "zod";
import { redactText } from "../logging/redact.js";

export function ipcErrorText(
  value: string,
  secrets: string[] = [],
  limit = 1000,
) {
  const text = redactText(value, secrets).replace(/[\r\n\t]+/g, " ");

  return text.length > limit ? text.slice(0, limit - 8) + "…（已截断）" : text;
}

export function ipcSchemaDetails(error: ZodError) {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "message"}: ${issue.code}`)
    .join("; ");
}

export function ipcFailureDetails(error: unknown, depth = 0): string {
  if (error instanceof ZodError) {
    return `协议字段校验失败：${ipcSchemaDetails(error)}`;
  }

  const source = error && typeof error === "object" ? error : undefined;
  const message = source ? Reflect.get(source, "message") : error;
  const code = source ? Reflect.get(source, "code") : undefined;
  const detail =
    typeof message === "string" && message.trim()
      ? message.trim()
      : "处理程序未提供错误详情";
  const cause = source ? Reflect.get(source, "cause") : undefined;

  return `${typeof code === "string" ? `[${code}] ` : ""}${detail}${cause !== undefined && depth < 2 ? `；原因：${ipcFailureDetails(cause, depth + 1)}` : ""}`;
}

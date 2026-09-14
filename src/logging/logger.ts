/**
 * 创建各模块共用的 Pino 日志，将紧凑、可直接阅读的纯文本诊断记录写到本机文件和标准输出。
 * 服务和评测入口调用 createLogger，再为具体模块创建带任务关联标识的子日志。
 *
 * 1. serializeError 提取 Error 的名称、消息、受控元数据、原因链和堆栈，避免调用方只记录 errorName。
 * 2. formatLogRecord 将 Pino 的内部记录转换为“时间 级别 模块 事件 | 键=值”的格式，省去应用、进程等固定噪声。
 * 3. createLogger 准备 logs 目录和 Writable 输出流，在格式化前按当前密钥列表脱敏，并按数量上限轮转旧文件。
 *
 * Pino 的内部流仍使用结构化记录以执行字段脱敏；落盘和输出绝不保留 JSON。日志写失败时只输出固定提示，
 * 不能把原始内容带出来，也不能因此中断任务。会话历史另存于 Store，不从日志恢复。
 */

import pino from "pino";
import { Writable } from "node:stream";
import {
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { redactJson, redactText } from "./redact.js";

const MAX_VALUE_LENGTH = 2000;
const MAX_STACK_LENGTH = 12000;
const ignoredFields = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "app",
  "module",
  "event",
  "msg",
  "message",
  "err",
]);
const contextLabels: Record<string, string> = {
  sessionId: "session",
  taskId: "task",
  toolCallId: "toolCall",
  requestId: "request",
};

/** 将未知异常收敛为不会包含任意响应正文的可记录字段，并限制原因链深度。 */
export function serializeError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  const source = error && typeof error === "object" ? error : undefined;
  const read = (key: string) => (source ? Reflect.get(source, key) : undefined);
  const name = error instanceof Error ? error.name : read("name");
  const message = error instanceof Error ? error.message : read("message");
  const record: Record<string, unknown> = {
    name: typeof name === "string" && name ? name : "Error",
    message:
      typeof message === "string" && message
        ? message
        : typeof error === "string"
          ? error
          : "Unknown error",
  };

  for (const key of [
    "code",
    "status",
    "requestId",
    "retryable",
    "retryAfterMs",
  ]) {
    const value = read(key);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      record[key] = value;
    }
  }

  const stack = error instanceof Error ? error.stack : read("stack");
  if (typeof stack === "string") {
    record.stack = stack;
  }

  const cause = read("cause");
  if (cause !== undefined && depth < 3) {
    record.cause = serializeError(cause, depth + 1);
  }

  return record;
}

function truncate(value: string, limit = MAX_VALUE_LENGTH) {
  return value.length > limit
    ? value.slice(0, limit) + `…（已截断，共 ${value.length} 个字符）`
    : value;
}

function formatValue(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    const text = truncate(value).replace(/\r?\n/g, "\\n");

    return /[\s="\\]/.test(text) || !text
      ? `"${text.replace(/"/g, '\\"')}"`
      : text;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return depth >= 2
      ? "[…]"
      : `[${value
          .slice(0, 8)
          .map((item) => formatValue(item, depth + 1))
          .join(", ")}${value.length > 8 ? ", …" : ""}]`;
  }

  if (value && typeof value === "object") {
    if (depth >= 2) {
      return "{…}";
    }

    const entries = Object.entries(value as Record<string, unknown>);

    return `{${entries
      .slice(0, 8)
      .map(([key, item]) => `${key}=${formatValue(item, depth + 1)}`)
      .join(" ")}${entries.length > 8 ? " …" : ""}}`;
  }

  return String(value);
}

function formatTimestamp(value: unknown) {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return typeof value === "string" ? value : new Date().toISOString();
}

interface FormattedError {
  summary: string;
  metadata: string[];
  cause?: string;
  stack?: string;
}

function formatError(error: unknown): FormattedError {
  const detail =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : serializeError(error);
  const name = typeof detail.name === "string" ? detail.name : "Error";
  const message =
    typeof detail.message === "string" ? detail.message : "Unknown error";
  const metadata = ["code", "status", "requestId", "retryable", "retryAfterMs"]
    .filter((key) => detail[key] !== undefined)
    .map((key) => `${key}=${formatValue(detail[key])}`);
  const cause =
    detail.cause && typeof detail.cause === "object"
      ? formatError(detail.cause).summary
      : undefined;
  const stack =
    typeof detail.stack === "string"
      ? truncate(detail.stack, MAX_STACK_LENGTH)
          .split(/\r?\n/)
          .map((line) => `    ${line}`)
          .join("\n")
      : undefined;

  return {
    summary: `${name}: ${formatValue(message)}`,
    metadata,
    cause,
    stack,
  };
}

/** 将已脱敏的 Pino 记录变成供人扫描的一行；堆栈以缩进行紧跟错误摘要。 */
export function formatLogRecord(record: Record<string, unknown>) {
  const level =
    typeof record.level === "number"
      ? (pino.levels.labels[record.level]?.toUpperCase() ?? "INFO")
      : "INFO";
  const module = typeof record.module === "string" ? record.module : "app";
  const eventFromMessage =
    typeof record.event !== "string" && typeof record.msg === "string";
  const event =
    typeof record.event === "string"
      ? record.event
      : typeof record.msg === "string"
        ? record.msg
        : "log";
  const fields: string[] = [];

  for (const key of ["sessionId", "taskId", "toolCallId", "requestId"]) {
    if (record[key] !== undefined) {
      fields.push(`${contextLabels[key]}=${formatValue(record[key])}`);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (!ignoredFields.has(key) && !contextLabels[key] && value !== undefined) {
      fields.push(`${key}=${formatValue(value)}`);
    }
  }

  const message =
    typeof record.msg === "string"
      ? record.msg
      : typeof record.message === "string"
        ? record.message
        : undefined;
  // 事件直接来自 Pino msg 或 err 时，文本已在事件或错误摘要中，不能重复输出。
  if (message && !eventFromMessage && record.err === undefined) {
    fields.push(`message=${formatValue(message)}`);
  }

  let line = `${formatTimestamp(record.time)} ${level.padEnd(5)} ${module} ${event}`;
  if (fields.length) {
    line += ` | ${fields.join(" ")}`;
  }

  if (record.err !== undefined) {
    const error = formatError(record.err);
    line += ` | error=${error.summary}`;
    if (error.metadata.length) {
      line += ` ${error.metadata.join(" ")}`;
    }

    if (error.cause) {
      line += ` cause=${error.cause}`;
    }

    if (error.stack) {
      line += `\n  stack:\n${error.stack}`;
    }
  }

  return line;
}

export function createLogger(
  directory: string,
  level: string,
  getSecrets: () => string[] = () => [],
) {
  const folder = path.join(directory, "logs");

  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "app.log");
  // 日志写失败也要让任务继续，错误提示不能带出原始日志内容。
  const output = new Writable({
    write(chunk, _encoding, done) {
      try {
        const clean = redactJson(String(chunk), getSecrets());
        const line =
          redactText(
            formatLogRecord(JSON.parse(clean) as Record<string, unknown>),
            getSecrets(),
          ) + "\n";

        if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
          if (existsSync(file + ".4")) {
            unlinkSync(file + ".4");
          }

          for (let i = 3; i >= 1; i--) {
            if (existsSync(file + "." + i)) {
              renameSync(file + "." + i, file + "." + (i + 1));
            }
          }

          renameSync(file, file + ".1");
        }

        appendFileSync(file, line, { mode: 0o600 });
        process.stdout.write(line);
        done();
      } catch {
        process.stderr.write("CodeAtelier: log output unavailable\n");
        done();
      }
    },
  });

  return pino(
    {
      level,
      base: undefined,
      serializers: { err: serializeError },
      redact: {
        paths: ["apiKey", "authorization", "req.headers.authorization"],
        censor: "[REDACTED]",
      },
    },
    output,
  );
}

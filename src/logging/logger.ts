/**
 * 文件作用：创建统一的 Pino 诊断日志入口。
 *
 * 模块协作与输入输出：
 * 由服务与评测入口创建 Pino 实例，输出到本机日志文件和标准输出，供各模块创建关联子日志。
 *
 * 代码结构与执行顺序：
 * 1. createLogger 创建 logs 目录并定义 Writable 输出流。
 * 2. 每次写入先检查大小并轮转 app.log 及有限归档，再用当前密钥集合脱敏。
 * 3. Pino 配置统一 app 字段、最低级别和结构化凭据字段遮盖。
 *
 * 关键约束：
 * 日志写入失败仅输出固定降级提示，不抛出原始载荷中断任务；历史会话不使用该日志文件保存。
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
import { redactJson } from "./redact.js";

export function createLogger(
  directory: string,
  level: string,
  getSecrets: () => string[] = () => [],
) {
  const folder = path.join(directory, "logs");

  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "app.log");
  // 日志失败不能中断编码任务；降级提示不携带原始日志载荷。
  const output = new Writable({
    write(chunk, _encoding, done) {
      try {
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

        const line = redactJson(String(chunk), getSecrets()) + "\n";

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
      base: { app: "CodeAtelier" },
      redact: {
        paths: ["apiKey", "authorization", "req.headers.authorization"],
        censor: "[REDACTED]",
      },
    },
    output,
  );
}

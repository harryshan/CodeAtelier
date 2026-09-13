/**
 * 创建各模块共用的 Pino 日志，将诊断信息写到本机日志文件和标准输出。
 * 服务和评测入口调用 createLogger，再为具体模块创建子日志。
 *
 * 1. createLogger 准备 logs 目录和 Writable 输出流。
 * 2. 写入时检查 app.log 大小，按数量上限轮转旧文件，并使用当前密钥列表脱敏。
 * 3. Pino 统一设置应用标识、最低日志级别和需要遮盖的凭据字段。
 *
 * 日志写失败时只输出固定提示，不能把原始内容带出来，也不能因此中断任务。
 * 会话历史另存于 Store，不从日志恢复。
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
  // 日志写失败也要让任务继续，错误提示不能带出原始日志内容。
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

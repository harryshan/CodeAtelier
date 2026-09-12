/**
 * 文件作用：创建统一的 Pino 诊断日志入口。
 * 代码结构：createLogger 准备日志目录和输出流，在写入时轮转、脱敏并处理存储故障，最后配置日志级别与结构化字段脱敏。
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

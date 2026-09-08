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

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
export function redactText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(
      /("(?:api[_-]?key|token|password|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    );
}
export function createLogger(
  directory: string,
  level: string,
  getSecrets: () => string[] = () => [],
) {
  const folder = path.join(directory, "logs");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "app.log");
  const output = new Writable({
    write(chunk, _encoding, done) {
      try {
        if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
          if (existsSync(file + ".4")) unlinkSync(file + ".4");
          for (let i = 3; i >= 1; i--)
            if (existsSync(file + "." + i))
              renameSync(file + "." + i, file + "." + (i + 1));
          renameSync(file, file + ".1");
        }
        const line = redactText(String(chunk), getSecrets());
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

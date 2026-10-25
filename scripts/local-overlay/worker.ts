/**
 * 手动 Local overlay 验证的独立子进程，只处理父脚本保存的实验批次。
 * 1. 加载批次后通过 IPC ready/go 屏障同时开始，验证跨进程发布锁。
 * 2. 对候选 .mjs 文件运行真实 Node --check，候选验证文件只写实验控制目录。
 * 3. crash 模式在第一个来源替换后、成功日志前立即 exit，模拟丢失确认的进程退出。
 * 4. 普通完成返回状态并断开 IPC；不启动产品服务、模型、Git 或系统挂载。
 * 使用项目统一纯文本 logger，每个批次写独立实验日志目录，避免多个进程轮转竞争。
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadBatch } from "./session.js";
import { Publisher } from "./publisher.js";
import { createLogger } from "../../src/logging/logger.js";

const execute = promisify(execFile);
const [mode, coordinator, manifest] = process.argv.slice(2);
if (
  !coordinator ||
  !manifest ||
  !["publish", "crash"].includes(mode ?? "") ||
  !process.send
) {
  throw new Error("This worker requires the manual fixture launcher and IPC.");
}

const batch = await loadBatch(manifest);
const start = new Promise<void>((resolve) =>
  process.once("message", (message) => {
    if (message !== "go") {
      throw new Error("Invalid fixture barrier.");
    }

    resolve();
  }),
);
process.send({ state: "ready" });
await start;
try {
  const log = createLogger(
    path.join(coordinator, "diagnostics", batch.id),
    "info",
  );
  const result = await new Publisher(coordinator, log).publish(batch, {
    lockTimeoutMs: 10_000,
    validate: async (files) => {
      const directory = path.join(coordinator, "validation", batch.id);
      await mkdir(directory, { recursive: true });
      let index = 0;
      for (const [name, content] of files) {
        if (name.endsWith(".mjs") && content !== null) {
          const target = path.join(directory, `${index++}.mjs`);
          await writeFile(target, content, { flag: "wx" });
          await execute(process.execPath, ["--check", target], {
            windowsHide: true,
            timeout: 5000,
          });
        }
      }
    },
    afterWrite: async (index) => {
      if (mode === "crash" && index === 0) {
        process.exit(86);
      }
    },
  });
  process.send({ state: "complete", ...result });
} catch (error) {
  process.send({
    state: "failed",
    reason: error instanceof Error ? error.message : "Unknown worker failure",
  });
  process.exitCode = 1;
} finally {
  process.disconnect();
}

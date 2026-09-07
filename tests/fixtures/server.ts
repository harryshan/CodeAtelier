import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { Config } from "../../src/config/settings.js";
import { createApp } from "../../src/server/app.js";
const config = new Config(
  await realpath(await mkdtemp(path.join(tmpdir(), "codeatelier-ui-"))),
);
config.apiKey = "test-key";
const { app, engine } = await createApp(
  config,
  pino({ enabled: false }),
  () => {
    let step = 0;
    return {
      async run(input, _instructions, _tools, signal, onDelta) {
        signal.throwIfAborted();
        step++;
        const lastUser =
          [...input].reverse().find((i) => i.role === "user")?.content || "";
        const tool = (name: string, args: unknown) => ({
          output: [
            {
              type: "function_call",
              name,
              arguments: JSON.stringify(args),
              call_id: "call-" + step,
            },
          ],
          text: "",
        });
        if (step === 1 && lastUser.includes("命令"))
          return tool("run_command", {
            command: process.execPath,
            args: ["-e", 'console.log("VERIFIED")'],
            cwd: ".",
          });
        if (step === 1 && lastUser.includes("修改"))
          return tool("write_file", {
            path: "result.txt",
            content: "CodeAtelier verified\n",
          });
        const text = "任务完成，已检查工具结果。";
        for (const part of ["任务完成，", "已检查工具结果。"]) {
          onDelta(part);
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          text,
        };
      },
    };
  },
);
await app.listen({ host: "127.0.0.1", port: 4143 });
process.on("SIGTERM", async () => {
  await engine.close();
  await app.close();
  process.exit(0);
});

/**
 * Playwright 使用的本机测试服务器，复用生产 createApp 和页面接口。
 * 配置保存在临时目录，模型使用固定响应，不连接外部服务。
 *
 * 1. 模拟模型提供固定容量，按提示和步骤返回工具调用、文本或断流错误。
 * 2. 长历史用例生成足以触发压缩的内容，摘要请求返回符合格式要求的模拟摘要。
 * 3. 文件和命令请求交给真实 ToolRunner；普通回复分段输出并带固定 usage。
 * 4. 启动测试端口，收到 SIGTERM 后关闭引擎和应用。
 *
 * 这里只替换模型，不为测试另开绕过鉴权、审批或数据库保存的业务接口。
 */

import { ModelError } from "../../src/providers/model-error.js";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { Config } from "../../src/config/config.js";
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
      async getCapabilities() {
        return {
          tokenizer: "o200k_base",
          limits: {
            max_context_window_tokens: 372000,
            max_output_tokens: 128000,
          },
        };
      },
      async run(input, _instructions, _tools, signal, onDelta) {
        signal.throwIfAborted();
        if (!_tools.length) {
          return {
            output: [],
            text: JSON.stringify({
              completed: [],
              conclusions: [],
              verification: [],
              pending: [],
            }),
          };
        }

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

        if (step === 1 && lastUser === "准备上下文压缩") {
          return {
            output: [
              {
                role: "assistant",
                content: "历史材料 const value = 123;\n".repeat(40000),
              },
            ],
            text: "已准备长历史。",
          };
        }

        if (step === 1 && lastUser.includes("模型重试")) {
          onDelta("第一次尝试的部分回复");
          throw new ModelError("模拟断流", true, "stream_disconnected");
        }

        if (step === 1 && lastUser.includes("命令")) {
          return tool("run_command", {
            command: process.execPath,
            args: ["-e", 'console.log("VERIFIED")'],
            cwd: ".",
          });
        }

        if (step === 1 && lastUser.includes("修改")) {
          return tool("write_file", {
            path: "result.txt",
            content: "CodeAtelier verified\n",
          });
        }

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
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
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

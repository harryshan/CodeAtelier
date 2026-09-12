/**
 * 文件作用：为 Playwright 提供使用模拟模型的本机测试服务器。
 *
 * 使用场景与输入输出：
 * 由 Playwright webServer 配置启动，复用 createApp 和生产 UI 接口，使用临时配置与固定测试密钥。
 *
 * 代码结构与阅读顺序：
 * 1. 模拟 getCapabilities 返回固定容量，run 根据步骤及提示生成工具请求、文本或断流错误。
 * 2. 长历史场景提供触发压缩的材料，无工具请求返回符合 schema 的模拟摘要。
 * 3. 写入和命令场景仍进入真实 ToolRunner；普通回复分段发送并附固定 usage。
 * 4. 最后监听本机测试端口，并在 SIGTERM 中关闭引擎和应用。
 *
 * 维护注意事项：
 * 没有独立测试业务路由；替身控制模型输出而不绕过生产 API 权限或数据库保存。
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

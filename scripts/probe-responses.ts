/**
 * 手动检查真实 Responses 服务能否完成“请求工具、返回结果、继续回复”的流式交互。
 * 直接使用 SDK，端点、模型和密钥从 --data-dir 指定的私有 settings.json 读取，不加载 dotenv。
 *
 * 1. 创建不自动重试的客户端，只声明 echo_probe 诊断工具。
 * 2. 第一轮收集文本、工具调用和事件类型。
 * 3. 把工具结果追加到上下文，发起第二轮请求并读取最终回复。
 * 4. 出错时报告诊断信息，便于检查服务与 SDK 的协议差异。
 *
 * 只处理固定的 echo 工具，不执行模型任意命令；该脚本会访问真实服务。
 */

import OpenAI from "openai";
import { startupConfig } from "../src/config/startup.js";

const config = startupConfig();
const key = config.modelKey();

if (!key) {
  throw new Error("请先在设置页配置主模型密钥。");
}

const baseURL = config.settings.baseUrl;
const model = config.settings.model;
if (!baseURL || !model || config.settings.protocol !== "responses") {
  throw new Error("该手动探针要求已配置的 Responses 主模型。");
}

const client = new OpenAI({
  apiKey: key,
  baseURL,
  maxRetries: 0,
  timeout: 60000,
});

const tools = [
  {
    type: "function" as const,
    name: "echo_probe",
    description: "Return a diagnostic marker. Call exactly once.",
    strict: true,
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

let output: any[] = [];

const types = new Set<string>();

try {
  const stream = await client.responses.create(
    {
      model,
      stream: true,
      store: false,
      input: [
        {
          role: "user",
          content:
            "Call echo_probe with message CODEATELIER_OK. After receiving the tool result, reply exactly CODEATELIER_OK.",
        },
      ],
      tools,
    },
    { signal: AbortSignal.timeout(60000) },
  );

  for await (const e of stream) {
    types.add(e.type);
    if (e.type === "response.output_item.done") {
      output.push(e.item);
    }

    if (e.type === "response.completed" && e.response.output?.length) {
      output = e.response.output;
    }
  }

  const call = output.find((i) => i.type === "function_call");

  console.log(
    JSON.stringify({
      stage: "stream",
      events: [...types],
      toolCall: call?.name || null,
    }),
  );
  if (!call) {
    throw new Error("No tool call received.");
  }

  const follow = await client.responses.create(
    {
      model,
      stream: true,
      store: false,
      input: [
        {
          role: "user",
          content:
            "Call echo_probe with message CODEATELIER_OK. After receiving the tool result, reply exactly CODEATELIER_OK.",
        },
        ...output,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "CODEATELIER_OK",
        },
      ],
      tools,
    },
    { signal: AbortSignal.timeout(60000) },
  );
  let text = "";

  for await (const e of follow) {
    if (e.type === "response.output_text.delta") {
      text += e.delta;
    }
  }

  console.log(JSON.stringify({ stage: "tool_result", text }));
} catch (error: any) {
  console.error(
    JSON.stringify({
      error: error.name,
      status: error.status,
      message: String(error.message)
        .replaceAll(key, "[REDACTED]")
        .slice(0, 500),
    }),
  );
  process.exitCode = 1;
}

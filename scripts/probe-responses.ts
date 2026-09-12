/**
 * 文件作用：手动验证真实 Responses 服务的流式工具调用往返。
 *
 * 使用场景与输入输出：
 * 供手动验证自建服务的 Responses 流与工具往返，直接使用 SDK，独立于生产 Engine。
 *
 * 代码结构与阅读顺序：
 * 1. 读取本地密钥及端点，禁用 SDK 重试并定义唯一 echo_probe 工具。
 * 2. 首轮消费文本和输出事件，整理工具调用及事件类型诊断。
 * 3. 把工具结果随协议上下文交回服务，第二轮读取最终文本。
 * 4. 异常路径报告探测失败，便于定位 SDK 与服务协议差异。
 *
 * 维护注意事项：
 * 只运行固定诊断工具，不执行模型任意工具；属于显式真实服务探测，不是默认测试。
 */

import OpenAI from "openai";

const key = process.env.CODEATELIER_API_KEY;

if (!key) {
  throw new Error("Set CODEATELIER_API_KEY locally.");
}

const client = new OpenAI({
  apiKey: key,
  baseURL:
    process.env.CODEATELIER_BASE_URL || "http://jp.harryshan.com:4141/v1",
  maxRetries: 0,
  timeout: 60000,
});

const model = process.env.CODEATELIER_MODEL || "codex/gpt-5.6-luna";

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

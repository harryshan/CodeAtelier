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

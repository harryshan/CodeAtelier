import pino from "pino";
import OpenAI from "openai";
import { ResponsesProvider } from "../src/providers/responses-provider.js";
import { createBudget } from "../src/context/token-budget.js";
import { settingsSchema } from "../src/config/settings.js";

const log = pino({ base: { module: "model-probe" } });
const key = process.env.CODEATELIER_API_KEY;
if (!key) {
  log.error(
    { event: "probe.missing_key" },
    "请通过本地环境设置 CODEATELIER_API_KEY。",
  );
  process.exitCode = 1;
} else {
  const settings = settingsSchema.parse({
    baseUrl:
      process.env.CODEATELIER_BASE_URL || "http://jp.harryshan.com:4141/v1",
    model: process.env.CODEATELIER_MODEL || "codex/gpt-5.6-luna",
    maxSteps: 1,
    commandTimeoutMs: 1000,
    requestTimeoutMs: 45000,
    idleTimeoutMs: 15000,
    contextChars: 180000,
    outputChars: 1000,
    logLevel: "info",
  });
  const provider = new ResponsesProvider(settings, key);
  const signal = AbortSignal.timeout(60000);
  const input = [{ role: "user", content: "Reply only OK." }];
  try {
    const capabilities = await provider.getCapabilities(signal);
    const budget = createBudget(
      capabilities,
      settings.contextChars,
      settings.maxOutputTokens,
    );
    log.info({
      event: "probe.capabilities",
      capabilities,
      unit: budget.unit,
      inputLimit: budget.limit,
      outputTokens: budget.outputTokens,
    });
    const client = new OpenAI({
      apiKey: key,
      baseURL: settings.baseUrl,
      maxRetries: 0,
      timeout: 10000,
    });
    try {
      const count = await client.post<{ input_tokens?: number }>(
        "/responses/input_tokens",
        { body: { model: settings.model, input }, signal },
      );
      log.info({
        event: "probe.input_tokens",
        inputTokens:
          typeof count.input_tokens === "number" ? count.input_tokens : null,
      });
    } catch (error: any) {
      log.info({
        event: "probe.input_tokens_unavailable",
        status: error?.status,
      });
    }

    const response = await provider.run(input, "", [], signal, () => {}, {
      maxOutputTokens: budget.outputTokens,
    });
    log.info({
      event: "probe.completed",
      usage: response.usage,
      estimatedInput: budget.measure(input, "", []),
      unit: budget.unit,
    });
  } catch (error: any) {
    log.error({
      event: "probe.failed",
      status: error?.status,
      code: error?.code === "context_length_exceeded" ? error.code : undefined,
    });
    process.exitCode = 1;
  }
}

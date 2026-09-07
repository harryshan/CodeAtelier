import { it, expect } from "vitest";
import { createServer } from "node:http";
import { ResponsesProvider } from "../src/providers/responses.js";
import type { Settings } from "../src/shared/types.js";
const settings: Settings = {
  baseUrl: "",
  model: "test",
  maxSteps: 3,
  commandTimeoutMs: 1000,
  requestTimeoutMs: 3000,
  idleTimeoutMs: 1000,
  contextChars: 10000,
  outputChars: 1000,
  logLevel: "info",
};
async function withServer(
  events: unknown[],
  run: (url: string) => Promise<void>,
) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events)
      res.write("data: " + JSON.stringify(event) + "\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    await run("http://127.0.0.1:" + address.port + "/v1");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
it("collects item.done when completed output is empty and preserves function calls", async () => {
  const call = {
    type: "function_call",
    name: "read_file",
    call_id: "a",
    arguments: "{}",
  };
  await withServer(
    [
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { output: [] } },
    ],
    async (baseUrl) => {
      const result = await new ResponsesProvider(
        { ...settings, baseUrl },
        "test-key",
      ).run([], "", [], new AbortController().signal, () => {});
      expect(result.output).toEqual([call]);
    },
  );
});
it("streams text and rejects missing completion", async () => {
  await withServer(
    [{ type: "response.output_text.delta", delta: "hello" }],
    async (baseUrl) => {
      const chunks: string[] = [];
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "key").run(
          [],
          "",
          [],
          new AbortController().signal,
          (s) => chunks.push(s),
        ),
      ).rejects.toThrow("未收到完成");
      expect(chunks).toEqual(["hello"]);
    },
  );
});
it("does not treat failed/incomplete events as successful completion", async () => {
  for (const type of ["response.failed", "response.incomplete", "error"])
    await withServer([{ type }], async (baseUrl) => {
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "key").run(
          [],
          "",
          [],
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("失败或不完整");
    });
});

// Deterministic Responses fixture for the adapter contract test, not a benchmark model.
import http from "node:http";

const stages = [
  ["read_file", { path: "math.mjs", startLine: 1, endLine: 20 }],
  ["edit_file", { path: "math.mjs", oldText: "a - b", newText: "a + b" }],
  ["run_command", { command: "node", args: ["--test"], cwd: "." }],
];
let calls = 0;

http
  .createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [] }));

      return;
    }

    if (request.url !== "/v1/responses") {
      response.writeHead(404).end();

      return;
    }

    for await (const chunk of request) {
      // Consume the body so the real Responses client can reuse its connection.
      void chunk;
    }

    const stage = stages[calls++];
    const output = stage
      ? [
          {
            type: "function_call",
            id: `item-${calls}`,
            call_id: `call-${calls}`,
            name: stage[0],
            arguments: JSON.stringify(stage[1]),
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "final",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Fixed addition and ran visible tests.",
                annotations: [],
              },
            ],
          },
        ];
    response.setHeader("content-type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: `response-${calls}`,
          status: "completed",
          output,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      })}\n\n`,
    );
  })
  .listen(18765, "127.0.0.1");

/**
 * 验证阅读器从实际模型材料恢复未进入主工具账本的函数调用，不运行模型或 Evaluation。
 * 1. 子任务读取、提问和参数错误都应成为可搜索的工具条目，并归属原模型请求。
 * 2. 不同子任务复用 call_id 时必须隔离结果；没有回执的调用保持未知，原生搜索不冒充本地工具。
 * 3. 旧捕获没有子身份时只用完整调用证据，不按时间或目的猜测；原始输入保持不变。
 */
import { expect, it } from "vitest";
import {
  parseReplayCase,
  projectReplay,
} from "../src/replay-viewer/projection.js";
import { viewerFixture } from "./fixtures/replay-viewer.js";
import { completeReplayTools } from "../src/shared/replay-tool-records.js";

it("recovers legacy checkpoints once and does not guess between identical child calls", () => {
  const request = call();
  const models = [
    {
      id: "old",
      purpose: "subagent",
      input: [],
      response: { output: [request] },
    },
  ];
  const children = [
    {
      id: "reader",
      context: [
        request,
        {
          type: "function_call_output",
          call_id: "shared",
          output: '{"text":"last checkpoint"}',
        },
      ],
    },
  ];
  const tools = completeReplayTools(models, [], children);
  expect(tools).toMatchObject([
    {
      subagentId: "reader",
      modelExchangeId: "old",
      result: { text: "last checkpoint" },
    },
  ]);
  expect(completeReplayTools(models, tools)).toEqual(tools);
  expect(completeReplayTools([], [], children)).toMatchObject([
    {
      subagentId: "reader",
      recordSource: "subagent-checkpoint",
      result: { text: "last checkpoint" },
    },
  ]);
  const ambiguous = completeReplayTools(
    models,
    [],
    [...children, { ...children[0], id: "other" }],
  );
  expect(ambiguous).toHaveLength(1);
  expect(ambiguous[0].subagentId).toBeUndefined();
  expect(ambiguous[0].result).toBeUndefined();
});

it("never reuses feedback from before the current response or invents success for duplicate calls", () => {
  const request = call("removed_tool", "{invalid");
  const models = [
    {
      id: "current",
      purpose: "task",
      input: [
        request,
        {
          type: "function_call_output",
          call_id: "shared",
          output: '{"success":true}',
        },
      ],
      response: { output: [request] },
    },
  ];
  expect(completeReplayTools(models, [])[0].result).toBeUndefined();
  const duplicate = completeReplayTools(
    [...models, { ...models[0], id: "duplicate" }],
    [],
  );
  expect(duplicate).toHaveLength(2);
  expect(duplicate.every((tool) => tool.result === undefined)).toBe(true);
});

it("does not infer a child identity from a checkpoint matching multiple old responses", () => {
  const request = call();
  const models = ["one", "two"].map((id) => ({
    id,
    purpose: "subagent",
    input: [],
    response: { output: [request] },
  }));
  const tools = completeReplayTools(
    models,
    [],
    [
      {
        id: "known-child",
        context: [
          request,
          {
            type: "function_call_output",
            call_id: "shared",
            output: "evidence",
          },
        ],
      },
    ],
  );
  expect(tools).toHaveLength(2);
  expect(
    tools.every(
      (tool) => tool.subagentId === undefined && tool.result === undefined,
    ),
  ).toBe(true);
});

it("does not let an old main tool ledger hide a child call with the same ID", () => {
  const data = fixture();
  const request = call();
  data.capture!.modelExchanges = ["task", "subagent"].map((purpose) => ({
    id: purpose,
    purpose,
    input: [],
    instructions: "",
    tools: [],
    response: { text: "", output: [request] },
  }));
  data.tools = [
    {
      callId: "shared",
      nodeId: "read",
      name: "read_file",
      arguments: { path: "src/a.ts" },
      dependsOn: [],
      batchId: "main-batch",
      result: { text: "main only" },
    },
  ];
  const tools = projectReplay(data).filter((entry) => entry.kind === "tool");
  expect(tools).toHaveLength(2);
  expect(tools[0]).toMatchObject({ modelKey: "model-0", status: "recorded" });
  expect(tools[1]).toMatchObject({ modelKey: "model-1", status: "unknown" });
});

function fixture() {
  const data = viewerFixture();
  data.tools = [];
  data.events = [];
  data.capture!.modelExchanges = [];

  return data;
}

function call(name = "read_file", args = '{"path":"src/a.ts"}') {
  return { type: "function_call", call_id: "shared", name, arguments: args };
}

it("shows subagent calls and feedback without requiring main tool_start records", () => {
  const data = fixture();
  for (const [id, name, args, result] of [
    ["reader", "read_file", '{"path":"src/a.ts"}', { text: "source" }],
    [
      "reviewer",
      "ask_main",
      '{"question":"which file?"}',
      { id: 7, queued: true },
    ],
    ["invalid", "read_file", "{broken", { error: "invalid JSON" }],
  ] as const) {
    const request = call(name, args);
    data.capture!.modelExchanges.push(
      {
        id,
        purpose: "subagent",
        subagentId: id,
        input: [],
        instructions: "",
        tools: [],
        response: { text: "", output: [request] },
      },
      {
        id: `${id}-next`,
        purpose: "subagent",
        subagentId: id,
        input: [
          request,
          {
            type: "function_call_output",
            call_id: "shared",
            output: JSON.stringify(result),
          },
        ],
        instructions: "",
        tools: [],
        response: { text: "done", output: [] },
      },
    );
  }

  const original = JSON.stringify(data);
  const entries = projectReplay(parseReplayCase(data));
  const tools = entries.filter((entry) => entry.kind === "tool");
  expect(tools).toHaveLength(3);
  expect(tools.map((entry) => entry.modelKey)).toEqual([
    "model-0",
    "model-2",
    "model-4",
  ]);
  expect(tools.map((entry) => entry.status)).toEqual([
    "recorded",
    "recorded",
    "error",
  ]);
  expect(tools.map((entry) => entry.tool?.result)).toEqual([
    { text: "source" },
    { id: 7, queued: true },
    { error: "invalid JSON" },
  ]);
  expect(tools[2].tool?.arguments).toBe("{broken");
  expect(JSON.stringify(data)).toBe(original);
});

it("keeps missing and conflicting results unknown and excludes native web search", () => {
  const data = fixture();
  const request = call();
  data.capture!.modelExchanges.push(
    {
      id: "first",
      purpose: "subagent",
      subagentId: "one",
      input: [],
      instructions: "",
      tools: [],
      response: {
        text: "",
        output: [
          request,
          { type: "web_search_call", id: "native", status: "completed" },
        ],
      },
    },
    {
      id: "other",
      purpose: "subagent",
      subagentId: "two",
      input: [
        request,
        {
          type: "function_call_output",
          call_id: "shared",
          output: "not this child's result",
        },
      ],
      instructions: "",
      tools: [],
    },
  );
  let tools = projectReplay(data).filter((entry) => entry.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0].status).toBe("unknown");
  for (const result of ["first result", "conflicting result"]) {
    data.capture!.modelExchanges.push({
      id: result,
      purpose: "subagent",
      subagentId: "one",
      input: [
        request,
        { type: "function_call_output", call_id: "shared", output: result },
      ],
      instructions: "",
      tools: [],
    });
  }

  tools = projectReplay(data).filter((entry) => entry.kind === "tool");
  expect(tools[0].status).toBe("unknown");
});

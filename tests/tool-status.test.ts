/**
 * 验证时间线工具卡片对 DAG 状态事件的纯映射。
 * ToolDisplayStatus 由 Timeline 调用；测试以最小持久化 Event 序列覆盖初始未调度、等待 slot、执行、依赖阻断及跨批次隔离，
 * 不渲染浏览器、不依赖 SSE。断言直接覆盖用户可见中文状态和样式类别。
 *
 * 1. event 构造器生成同一工具开始与可选 tool_state 历史。
 * 2. 用例确保最后状态生效，且其它批次或调用不能串扰当前卡片。
 */

import { expect, it } from "vitest";
import type { Event } from "../src/shared/types.js";
import { toolDisplayStatus } from "../src/web/tool-status.js";

function event(id: number, type: string, data: Record<string, unknown>): Event {
  return {
    id,
    type,
    data,
    sessionId: "session",
    taskId: "task",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

const start = event(1, "tool_start", { callId: "call", batchId: "batch" });

it.each([
  [[], { label: "等待调度", tone: "waiting" }],
  [
    [
      event(2, "tool_state", {
        callId: "call",
        batchId: "batch",
        state: "queued",
      }),
    ],
    { label: "已显示，等待可用执行槽", tone: "waiting" },
  ],
  [
    [
      event(2, "tool_state", {
        callId: "call",
        batchId: "batch",
        state: "executing",
      }),
    ],
    { label: "正在执行", tone: "running" },
  ],
  [
    [
      event(2, "tool_state", {
        callId: "call",
        batchId: "batch",
        state: "blocked",
      }),
    ],
    { label: "因前置失败未执行", tone: "blocked" },
  ],
] as const)(
  "shows %o for the last matching scheduler state",
  (states, expected) => {
    expect(toolDisplayStatus([start, ...states], start)).toEqual(expected);
  },
);

it("ignores another call or batch when resolving a tool card state", () => {
  const states = [
    event(2, "tool_state", {
      callId: "other",
      batchId: "batch",
      state: "executing",
    }),
    event(3, "tool_state", {
      callId: "call",
      batchId: "other",
      state: "executing",
    }),
    event(4, "tool_state", {
      callId: "call",
      batchId: "batch",
      state: "waiting_dependencies",
    }),
  ];

  expect(toolDisplayStatus([start, ...states], start)).toEqual({
    label: "等待前置工具",
    tone: "waiting",
  });
});

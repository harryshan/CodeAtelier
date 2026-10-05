/**
 * 离线阅读器单元与浏览器测试共享的合成任务，不含真实用户历史或连接配置。
 * 1. viewerFixture 返回三次模型请求：工具请求、同一步重试失败以及没有终态的请求。
 * 2. 工具包含正常正文、非零退出与未关联的未知结果，事件包含用户消息和审批材料。
 * 3. 每次返回独立对象，测试可扩展大文本、恶意载荷和分页；夹具不执行任何模型或工具。
 */

import type { ViewerCase } from "../../src/replay-viewer/projection.js";

export function viewerFixture(): ViewerCase {
  return {
    schemaVersion: 1,
    source: "captured",
    session: { title: "离线阅读测试", workspace: "C:/example" },
    task: { id: "task-1", status: "interrupted" },
    capture: {
      schemaVersion: 1,
      modelExchanges: [
        {
          id: "request-1",
          purpose: "task",
          step: 1,
          attempt: 1,
          instructions: "只在示例项目工作",
          input: [{ role: "user", content: "请读取示例文件" }],
          tools: [{ name: "read_file" }],
          response: {
            text: "先读取文件，再运行检查。",
            output: [
              { type: "function_call", call_id: "call-1", name: "read_file" },
              { type: "function_call", call_id: "call-2", name: "run_command" },
            ],
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          },
        },
        {
          id: "request-2",
          purpose: "task",
          step: 1,
          attempt: 2,
          input: [],
          instructions: "",
          tools: [],
          error: { message: "服务暂时不可用" },
        },
        {
          id: "request-3",
          purpose: "compaction",
          input: [],
          instructions: "",
          tools: [],
        },
      ],
    },
    tools: [
      {
        callId: "call-1",
        nodeId: "read",
        batchId: "batch-1",
        name: "read_file",
        dependsOn: [],
        arguments: { path: "src/example.ts" },
        result: { text: "first line\nsecond line" },
      },
      {
        callId: "call-2",
        nodeId: "check",
        batchId: "batch-1",
        name: "run_command",
        dependsOn: ["read"],
        arguments: { command: "pnpm test" },
        result: { exitCode: 1, output: "assertion failed" },
      },
      {
        callId: "orphan",
        nodeId: "unknown",
        batchId: "batch-2",
        name: "git",
        dependsOn: [],
        arguments: { request: { action: "status" } },
      },
    ],
    events: [
      {
        id: 1,
        type: "user",
        createdAt: "2026-10-05T00:00:00Z",
        data: { text: "请读取示例文件" },
      },
      {
        id: 2,
        type: "approval",
        createdAt: "2026-10-05T00:00:01Z",
        data: { reason: "示例审批事件" },
      },
    ],
  };
}

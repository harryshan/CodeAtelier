/**
 * 验证 replay case 对模型请求、历史读取文件版本和隔离目录的边界。
 * 这些用例直接使用 sessions/replay-case.ts 的纯契约：既检查完整分页读取可恢复编辑前文件，也检查局部
 * 读取、哈希不符和非新目录被拒绝；模型提供者检查请求不漂移。它们不执行真实命令、模型或用户工作区。
 *
 * 1. 构造带连续 read_file 分页和 edit_files fileVersion 的 captured case，物化到全新临时目录。
 * 2. 覆盖只读取局部行和版本不符时不宣称可重建文件场景。
 * 3. 驱动 RecordedModelProvider，检查确定性响应、参数漂移和未消费响应均可见。
 *
 * replay case 的目标是隔离复现 agent 所见材料，不是恢复 Git、进程或网络状态。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  RecordedModelProvider,
  ReplayMismatchError,
  analyzeReplayWorkspace,
  materializeReplayWorkspace,
  type TaskReplayCase,
} from "../src/sessions/replay-case.js";
import { temp } from "./fixtures/helpers.js";

const text = "first\nsecond\nthird";
const contentHash = createHash("sha256").update(text).digest("hex");

function replayCase(overrides: Partial<TaskReplayCase> = {}): TaskReplayCase {
  const session = {
    id: "session",
    title: "case",
    workspace: "C:/original",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    titleState: "completed" as const,
  };
  const task = {
    id: "task",
    sessionId: session.id,
    status: "completed" as const,
    subagentsEnabled: false,
    createdAt: session.createdAt,
  };

  return {
    schemaVersion: 1,
    source: "captured",
    session,
    task,
    capture: {
      schemaVersion: 1,
      capturedAt: session.createdAt,
      platform: "win32",
      settings: {
        model: "test-model",
        maxSteps: 3,
        commandTimeoutMs: 1,
        requestTimeoutMs: 1,
        idleTimeoutMs: 1,
        contextChars: 100,
        outputChars: 100,
      },
      modelExchanges: [
        {
          id: "model-1",
          purpose: "task",
          input: [{ role: "user", content: "fix" }],
          instructions: "rules",
          tools: [],
          response: { output: [], text: "done" },
        },
      ],
      tools: [],
      finalizedAt: session.updatedAt,
      status: "completed",
    },
    tools: [
      {
        callId: "read-1",
        nodeId: "read-1",
        batchId: "batch-1",
        name: "read_file",
        arguments: { path: "src/example.txt", startLine: 1, endLine: 2 },
        dependsOn: [],
        result: {
          contentHash,
          totalLines: 3,
          returnedEndLine: 2,
          text: "1: first\n2: second",
        },
      },
      {
        callId: "read-2",
        nodeId: "read-2",
        batchId: "batch-2",
        name: "read_file",
        arguments: { path: "src/example.txt", startLine: 3, endLine: 3 },
        dependsOn: [],
        result: {
          contentHash,
          totalLines: 3,
          returnedEndLine: 3,
          text: "3: third",
        },
      },
      {
        callId: "edit-1",
        nodeId: "edit-1",
        batchId: "batch-3",
        name: "edit_files",
        arguments: {
          files: [
            {
              path: "src/example.txt",
              create: false,
              fileVersion: contentHash,
              edits: [{ oldText: "second", newText: "fixed" }],
            },
          ],
        },
        dependsOn: [],
        result: { files: [{ path: "src/example.txt", status: "failed" }] },
      },
    ],
    events: [],
    ...overrides,
  };
}

it("reconstructs complete read pages into a new isolated edit_files workspace", async () => {
  const caseFile = replayCase();
  const analysis = analyzeReplayWorkspace(caseFile);
  const root = await temp();
  const target = path.join(root, "replay");

  expect(analysis).toMatchObject({ complete: true, missingPaths: [] });
  await materializeReplayWorkspace(caseFile, target);
  expect(await readFile(path.join(target, "src", "example.txt"), "utf8")).toBe(
    text,
  );
  await expect(materializeReplayWorkspace(caseFile, target)).rejects.toThrow();
});

it("marks partial reads and edit version mismatches as non-materializable", async () => {
  const originalTools = replayCase().tools;
  const partial = replayCase({
    tools: [originalTools[0], originalTools[2]],
  });
  const mismatch = replayCase();
  (mismatch.tools[2].arguments as any).files[0].fileVersion = "0".repeat(64);

  expect(analyzeReplayWorkspace(partial)).toMatchObject({
    complete: false,
    missingPaths: ["src/example.txt"],
  });
  expect(analyzeReplayWorkspace(mismatch)).toMatchObject({ complete: false });
});

it("returns recorded responses only for exactly matching model requests", async () => {
  const provider = new RecordedModelProvider(replayCase().capture!);
  const signal = new AbortController().signal;

  await expect(
    provider.run(
      [{ role: "user", content: "fix" }],
      "rules",
      [],
      signal,
      () => {},
    ),
  ).resolves.toMatchObject({ text: "done" });
  provider.assertConsumed();

  const drifted = new RecordedModelProvider(replayCase().capture!);
  await expect(
    drifted.run([], "rules", [], signal, () => {}),
  ).rejects.toBeInstanceOf(ReplayMismatchError);
});

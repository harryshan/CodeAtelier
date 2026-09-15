/**
 * 验证低成本模型审批的协议解析及三级决定如何改变 ApprovalManager 的行为。
 * 测试使用注入的 ModelProvider 或分类器，不访问真实服务、文件或命令。
 *
 * 1. assessApproval 检查无工具、低输出额度的请求，以及严格 JSON 输出与理由规范化。
 * 2. ApprovalManager 检查 approve 不创建待审批项，human review 保留原有点击流程和模型理由。
 * 3. reject 必须立即阻止操作并返回模型理由；分类器缺失时保持人工确认，不能意外自动通过。
 *
 * 这些用例只验证权限分流契约。ToolRunner 的路径、命令和文件副作用校验继续由各自回归测试覆盖。
 */

import { expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/approval-manager.js";
import {
  APPROVAL_INSTRUCTIONS,
  assessApproval,
  parseAssessment,
  type ApprovalAssessment,
} from "../src/permissions/model-approval.js";

const data = {
  sessionId: "session",
  taskId: "task",
  tool: "run_command",
  description: '{"command":"pnpm test","cwd":"/project"}',
};

it("sends only the approval subject to the low-cost provider and strictly parses its decision", async () => {
  const assessment = await assessApproval(
    {
      async run(input, instructions, tools, _signal, onDelta, options) {
        expect(input).toEqual([
          {
            role: "user",
            content:
              "<approval_request>\n" +
              JSON.stringify({
                tool: data.tool,
                description: data.description,
              }) +
              "\n</approval_request>",
          },
        ]);
        expect(instructions).toBe(APPROVAL_INSTRUCTIONS);
        expect(tools).toEqual([]);
        expect(options).toEqual({ maxOutputTokens: 256 });
        onDelta("must not be displayed");

        return {
          output: [],
          text: '{"decision":"approve","reason":"  固定验证命令  "}',
        };
      },
    },
    data,
    new AbortController().signal,
  );

  expect(assessment).toEqual({ decision: "approve", reason: "固定验证命令" });
  expect(() =>
    parseAssessment('```json\n{"decision":"approve","reason":"x"}\n```'),
  ).toThrow("JSON");
  expect(() =>
    parseAssessment('{"decision":"approve","reason":"x","extra":true}'),
  ).toThrow("无效决定");
});

it("automatically passes only an approve assessment and records the assessment callback", async () => {
  const assessed: ApprovalAssessment[] = [];
  const manager = new ApprovalManager(
    () => {},
    async () => ({ decision: "approve", reason: "受限测试命令" }),
    (_subject, assessment) => assessed.push(assessment),
  );

  await expect(
    manager.request(data, new AbortController().signal),
  ).resolves.toBe(true);
  expect(manager.list()).toEqual([]);
  expect(assessed).toEqual([{ decision: "approve", reason: "受限测试命令" }]);
});

it("keeps human review in the existing click workflow and exposes the model reason", async () => {
  const manager = new ApprovalManager(
    () => {},
    async () => ({ decision: "human review", reason: "会修改项目规则文件" }),
  );
  const pending = manager.request(data, new AbortController().signal, "grant");

  await expect
    .poll(() => manager.list())
    .toMatchObject([
      {
        tool: "run_command",
        repeatable: true,
        reviewReason: "会修改项目规则文件",
      },
    ]);
  manager.decide(manager.list()[0].id, "once");

  await expect(pending).resolves.toBe(true);
});

it("rejects dangerous requests with the model reason and falls back to human review without a classifier", async () => {
  const rejected = new ApprovalManager(
    () => {},
    async () => ({ decision: "reject", reason: "包含破坏性删除操作" }),
  );

  await expect(
    rejected.request(data, new AbortController().signal),
  ).rejects.toThrow("包含破坏性删除操作");
  expect(rejected.list()).toEqual([]);

  const fallback = new ApprovalManager(() => {});
  const pending = fallback.request(data, new AbortController().signal);

  expect(fallback.list()[0].reviewReason).toContain("未配置低成本审批模型");
  fallback.decide(fallback.list()[0].id, "deny");
  await expect(pending).resolves.toBe(false);
});

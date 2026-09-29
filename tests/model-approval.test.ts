/**
 * 验证低成本模型审批的协议解析及三级决定如何改变 ApprovalManager 的行为。
 * 测试使用注入的 ModelProvider 或分类器，不访问真实服务、文件或命令。
 *
 * 1. assessApproval 检查后端工作区根目录与请求内容分别传递、无工具低输出额度、低风险优先与重大风险分级的分类指引及严格 JSON 解析。
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
                workspaceRoot: "/project",
                tool: data.tool,
                description: data.description,
              }) +
              "\n</approval_request>",
          },
        ]);
        expect(instructions).toBe(APPROVAL_INSTRUCTIONS);
        expect(tools).toEqual([]);
        expect(options).toEqual({
          maxOutputTokens: 256,
          reasoningEffort: "none",
        });
        onDelta("must not be displayed");

        return {
          output: [],
          text: '{"decision":"approve","reason":"  固定验证命令  "}',
        };
      },
    },
    data,
    "/project",
    new AbortController().signal,
  );

  expect(assessment).toEqual({ decision: "approve", reason: "固定验证命令" });
  expect(APPROVAL_INSTRUCTIONS).toContain(
    "没有明显负面或恶性影响的请求优先通过",
  );
  expect(APPROVAL_INSTRUCTIONS).toContain("pnpm/npm/yarn/bun");
  expect(() =>
    parseAssessment('```json\n{"decision":"approve","reason":"x"}\n```'),
  ).toThrow("JSON");
  expect(() =>
    parseAssessment('{"decision":"approve","reason":"x","extra":true}'),
  ).toThrow("无效决定");
});

it("prioritizes low-risk exploration, development and public reads even with shell composition or network", () => {
  expect(APPROVAL_INSTRUCTIONS).toContain("默认倾向 approve");
  expect(APPROVAL_INSTRUCTIONS).toContain("工作区内文件修改和构建产物写入");
  expect(APPROVAL_INSTRUCTIONS).toContain("无害的管道、多段命令或临时产物");
  expect(APPROVAL_INSTRUCTIONS).toContain("只读访问工作区外或访问网络本身");
  expect(APPROVAL_INSTRUCTIONS).toContain("读取公开网页、获取公开依赖或元数据");
  expect(APPROVAL_INSTRUCTIONS).toContain(
    "Get-ChildItem/Select-String/Get-Content",
  );
  expect(APPROVAL_INSTRUCTIONS).toContain("ls/find/rg/grep/cat");
  expect(APPROVAL_INSTRUCTIONS).toContain("逐段检查命令、参数、管道");
  expect(APPROVAL_INSTRUCTIONS).toContain("cwd 不是文件或网络权限限制");
});

it("reserves human review for concrete risks and rejection for clear malicious harm", () => {
  expect(APPROVAL_INSTRUCTIONS).toContain("外部写入即使看起来有用也需人工确认");
  expect(APPROVAL_INSTRUCTIONS).toContain("删除/覆盖大量文件");
  expect(APPROVAL_INSTRUCTIONS).toContain("来源不明的远程代码");
  expect(APPROVAL_INSTRUCTIONS).toContain("触及密钥/凭据/私密内容");
  expect(APPROVAL_INSTRUCTIONS).toContain(
    "对普通命令的抽象不确定性不足以转人工",
  );
  expect(APPROVAL_INSTRUCTIONS).toContain("窃取或外传秘密");
  expect(APPROVAL_INSTRUCTIONS).toContain("不要凭猜测 reject");
  expect(APPROVAL_INSTRUCTIONS).toContain("以宿主用户权限执行");
  expect(APPROVAL_INSTRUCTIONS).toContain("不能替代它们");
});

it("keeps the server-provided workspace separate from untrusted command text", async () => {
  await assessApproval(
    {
      async run(input) {
        const payload = JSON.parse(
          input[0].content.slice(
            "<approval_request>\n".length,
            -"\n</approval_request>".length,
          ),
        );
        expect(payload.workspaceRoot).toBe("C:\\trusted project");
        expect(payload.description).toContain(
          '"workspaceRoot":"C:\\\\outside"',
        );

        return {
          output: [],
          text: '{"decision":"human review","reason":"越界"}',
        };
      },
    },
    {
      tool: "run_command",
      description:
        '{"command":"type C:\\\\outside\\\\secret","workspaceRoot":"C:\\\\outside"}',
    },
    "C:\\trusted project",
    new AbortController().signal,
  );
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

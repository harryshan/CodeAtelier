/*
 * 验证主 agent 分工协议的结构和依赖判定，不调用模型、Worker 或真实用户工作区。
 *
 * 1. 使用严格的 Zod schema 验证 action 和字段边界，以及 replyTo 空值/历史省略值兼容和非法问题 ID 拒绝。
 * 2. 验证依赖无环、已登记 ID、重复 ID；累计创建不再受旧数量阈值限制。
 *
 * 工具参数只是请求数据；通过结构校验不等于具备执行权限。
 */

import { expect, it } from "vitest";
import {
  subagentActionSchema,
  validateSubagentPlan,
} from "../src/agent/subagent-contracts.js";

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  role: "explorer" as const,
  objective: "调查入口",
  scope: ["src"],
  dependsOn,
  deliverable: "报告证据",
});

it("accepts structured plans and rejects unknown action fields", () => {
  const valid = subagentActionSchema.parse({
    request: { action: "plan", subtasks: [task("a")] },
  });
  expect(
    validateSubagentPlan(
      valid.request.action === "plan" ? valid.request.subtasks : [],
    ),
  ).toHaveLength(1);
  expect(() =>
    subagentActionSchema.parse({
      request: { action: "cancel", subagentId: "a", command: "write" },
    }),
  ).toThrow();
  expect(() =>
    subagentActionSchema.parse({
      request: { action: "await", subagentIds: ["a"], timeoutMs: 31_000 },
    }),
  ).toThrow();
});

it.each([undefined, null, 42])(
  "accepts message replyTo %s and normalizes omitted values",
  (replyTo) => {
    const request = {
      action: "message",
      subagentId: "reader",
      text: "Inspect the entry point",
      ...(replyTo === undefined ? {} : { replyTo }),
    };

    expect(subagentActionSchema.parse({ request }).request).toEqual({
      ...request,
      replyTo: replyTo ?? null,
    });
  },
);

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42"])(
  "rejects invalid message replyTo %s",
  (replyTo) => {
    expect(
      subagentActionSchema.safeParse({
        request: {
          action: "message",
          subagentId: "reader",
          text: "Reply",
          replyTo,
        },
      }).success,
    ).toBe(false);
  },
);

it("rejects duplicate, circular and unknown dependencies before spawning", () => {
  expect(() => validateSubagentPlan([task("a"), task("a")])).toThrow("重复");
  expect(() =>
    validateSubagentPlan([task("a", ["b"]), task("b", ["a"])]),
  ).toThrow("循环");
  expect(() => validateSubagentPlan([task("a", ["unknown"])])).toThrow(
    "不属于",
  );
  expect(() => validateSubagentPlan([task("a")], new Set(["a"]))).toThrow(
    "重复",
  );
  expect(
    validateSubagentPlan([task("e")], new Set(["a", "b", "c", "d"])),
  ).toHaveLength(1);
  expect(validateSubagentPlan([task("b", ["a"])], new Set(["a"]))).toHaveLength(
    1,
  );
});

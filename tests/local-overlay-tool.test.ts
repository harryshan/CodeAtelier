/**
 * Local 发布模型契约的边界回归：不启动挂载、Runtime 或真实发布。
 * 1. 默认宿主/Runtime 工具不泄露 Local 专属入口；显式定义使用标准 DAG 信封。
 * 2. 参数拒绝任意任务/目录/权限覆盖、空验证及超限计划；clear 不能夹带执行内容。
 * 3. 同一响应的重复选择在任何工具执行前失败；注册解析不等于活动任务授权。
 */
import { expect, it } from "vitest";
import {
  definitions,
  runtimeDefinitions,
  localPublicationDefinition,
  parseToolArguments,
} from "../src/tools/registry.js";
import { buildModelToolGraph } from "../src/tools/model-tool-batch.js";

const selection = {
  request: { action: "select", paths: ["src/a.ts"], commands: ["pnpm test"] },
};

it("exposes Local selection only as an explicit task capability", () => {
  expect(definitions.some((tool) => tool.name === "local_publish")).toBe(false);
  expect(runtimeDefinitions.some((tool) => tool.name === "local_publish")).toBe(
    false,
  );
  expect(localPublicationDefinition).toMatchObject({
    name: "local_publish",
    strict: true,
  });
  expect(parseToolArguments("local_publish", selection)).toEqual(selection);
  expect(
    parseToolArguments("local_publish", { request: { action: "clear" } }),
  ).toEqual({ request: { action: "clear" } });
});

it.each([
  { ...selection, taskId: "another-task" },
  { request: { ...selection.request, workspace: "elsewhere" } },
  { request: { ...selection.request, permissions: "host" } },
  { request: { ...selection.request, commands: [] } },
  { request: { ...selection.request, commands: [" "] } },
  { request: { ...selection.request, commands: Array(9).fill("echo test") } },
  { request: { ...selection.request, paths: [] } },
  { request: { action: "clear", commands: ["echo no"] } },
])("rejects unbounded or authority-changing requests (%j)", (input) => {
  expect(() => parseToolArguments("local_publish", input)).toThrow();
});

it("rejects competing selections before executing any DAG node", () => {
  const calls = ["a", "b"].map((id) => ({
    name: "local_publish",
    call_id: id,
    arguments: JSON.stringify({
      execution: { id, dependsOn: [] },
      arguments: selection,
    }),
  }));
  expect(() => buildModelToolGraph(calls)).toThrow("一次 Local 发布选择");
  expect(buildModelToolGraph(calls.slice(0, 1)).nodes).toHaveLength(1);
});

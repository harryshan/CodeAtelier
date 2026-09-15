/**
 * 检查 registry 发给模型的函数契约，防止单个非法工具使整轮请求被拒绝。
 * 使用生产 definitions 和 schemas，不调用模型服务，也不执行文件或 Git 操作。
 *
 * 1. 递归遍历工具定义及数组项，核对 strict 对象的属性均为必填且禁止额外属性。
 * 2. 检查 run_command 只向模型公开 command 字符串，以及单一 git 工具的 discriminated action 契约。
 *    每个 action 只接受自身所需字段，不能混入任意选项。
 */

import { expect, it } from "vitest";
import { definitions, schemas } from "../src/tools/registry.js";

it("declares every property as required for strict function tools", () => {
  for (const definition of definitions) {
    const parameters = definition.parameters;

    expect(definition.strict).toBe(true);
    const check = (schema: any) => {
      if (!schema || typeof schema !== "object") {
        return;
      }

      if (schema.type === "object") {
        expect(schema.additionalProperties, definition.name).toBe(false);
        expect([...(schema.required ?? [])].sort(), definition.name).toEqual(
          Object.keys(schema.properties ?? {}).sort(),
        );
      }

      for (const value of Object.values(schema)) {
        if (Array.isArray(value)) {
          value.forEach(check);
        } else if (value && typeof value === "object") {
          check(value);
        }
      }
    };

    check(parameters);
  }
});

it("accepts only one command string for run_command", () => {
  expect(schemas.run_command.parse({ command: "pnpm test" })).toEqual({
    command: "pnpm test",
  });
  expect(
    schemas.run_command.safeParse({
      command: "node",
      args: ["--test"],
      cwd: ".",
    }).success,
  ).toBe(false);
});

it("declares strict action-specific parameters for the single git tool", () => {
  expect(schemas.git.safeParse({ action: "status" }).success).toBe(true);
  expect(
    schemas.git.safeParse({ action: "status", staged: false }).success,
  ).toBe(false);
  expect(
    schemas.git.parse({
      action: "diff",
      staged: false,
      paths: [],
      contextLines: 0,
    }),
  ).toEqual({ action: "diff", staged: false, paths: [], contextLines: 0 });
  expect(
    schemas.git.safeParse({ action: "show", revision: "HEAD", paths: [] })
      .success,
  ).toBe(false);
});

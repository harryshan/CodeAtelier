/**
 * 检查 registry 发给模型的函数契约，防止单个非法工具使整轮请求被拒绝。
 * 使用生产 definitions 和 schemas，不调用模型服务，也不执行文件或 Git 操作。
 *
 * 1. 递归遍历工具定义及数组项，核对 strict 对象的属性均为必填且禁止额外属性。
 * 2. 检查 git_diff 的 staged 必须显式提供，并接受暂存和未暂存两种选择。
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

it("requires an explicit staged choice for git_diff", () => {
  expect(schemas.git_diff.safeParse({}).success).toBe(false);
  expect(schemas.git_diff.parse({ staged: false })).toEqual({ staged: false });
  expect(schemas.git_diff.parse({ staged: true })).toEqual({ staged: true });
});

/**
 * 验证宿主/Runtime 共用的模型工具反馈序列化；纯内存测试，不做脱敏或持久化。
 *
 * 1. 精确字符边界覆盖完整 JSON、截断封装与 Unicode，确认原对象不被修改。
 * 2. 循环引用和不可序列化顶层值保持失败，不把未知结果伪装成成功或空反馈。
 */

import { expect, it } from "vitest";
import { serializeToolOutput } from "../src/tools/model-tool-batch.js";

it.each([0, 1, 100])(
  "preserves the existing JSON truncation rule at limit %i",
  (limit) => {
    const result = { text: "中文😀", reports: [{ id: "child" }] };
    const before = JSON.stringify(result);
    const serialized = serializeToolOutput(result, limit);

    expect(serialized.complete).toBe(before.length <= limit);
    expect(serialized.output).toBe(
      before.length <= limit
        ? before
        : JSON.stringify({ truncated: true, text: before.slice(0, limit) }),
    );
    expect(JSON.stringify(result)).toBe(before);
  },
);

it("does not truncate a result exactly at the character limit", () => {
  const result = { ok: true };
  const output = JSON.stringify(result);

  expect(serializeToolOutput(result, output.length)).toEqual({
    output,
    complete: true,
  });
  expect(serializeToolOutput(result, output.length - 1).complete).toBe(false);
});

it("does not hide serialization errors", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  expect(() => serializeToolOutput(cyclic, 100)).toThrow();
  expect(() => serializeToolOutput(undefined, 100)).toThrow();
});

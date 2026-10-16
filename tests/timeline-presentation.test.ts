/**
 * 验证时间线纯展示投影，不依赖 DOM、后端或模型。
 * 1. 中文标签覆盖现行和旧记录；未知及原型属性名称必须中性兜底。
 * 2. 摘要区分缺失/空/原始字符串，读取元数据不推断成功，编辑计数保留失败及未知状态。
 * 3. 错误摘要限长但不修改原文，截断标记保持可见；不能解析字符串 JSON 冒充已验证字段。
 */
import { expect, it } from "vitest";
import {
  eventLabel,
  resultSummary,
  toolLabel,
} from "../src/web/timeline-presentation.js";

it("uses safe Chinese labels without exposing unknown identifiers as primary titles", () => {
  expect(toolLabel("mcp")).toBe("MCP 服务");
  expect(toolLabel("git_push")).toBe("Git 推送（旧记录）");
  expect(eventLabel("capability_output")).toBe("宿主命令输出");
  for (const name of ["future_tool", "constructor", "__proto__", undefined]) {
    expect(toolLabel(name)).toBe("工具调用");
  }

  expect(eventLabel("constructor")).toBe("历史记录");
});

it("does not equate an existing or missing result with success", () => {
  expect(resultSummary("mcp", undefined)).toBe("结果未记录");
  expect(resultSummary("mcp", null)).toBe("结果未记录");
  expect(resultSummary("mcp", "")).toBe("空文本结果");
  expect(resultSummary("mcp", '{"error":"failed"}')).toBe("文本结果 · 18 字符");
  expect(resultSummary("mcp", {})).toBe("结构化结果 · 展开查看");
  expect(resultSummary("mcp", false)).toBe("原始结果 · 展开查看");
});

it("summarizes reading metadata and truncation without scanning source text", () => {
  expect(
    resultSummary("read_file", {
      path: "sample.ts",
      totalLines: 100,
      hasMore: true,
      truncated: true,
      get text() {
        throw new Error("must not inspect source text");
      },
    }),
  ).toBe("sample.ts · 共 100 行 · 还有后续内容 · 结果已截断");
  expect(resultSummary("read_file", { totalLines: -1 })).toBe(
    "结构化结果 · 展开查看",
  );
});

it("counts partial edits and conservatively treats unfamiliar states as unknown", () => {
  expect(
    resultSummary("edit_files", {
      files: [
        { status: "written" },
        { status: "failed" },
        { status: "not_attempted" },
        { status: "unknown" },
        { status: "future" },
        null,
      ],
    }),
  ).toBe("已写入 1 · 失败 1 · 未知 3 · 未执行 1");
  const error = "failure ".repeat(30);
  const result = { error };
  expect(resultSummary("read_file", result)).toBe(
    `错误：${error.slice(0, 160)}…`,
  );
  expect(result.error).toBe(error);
});

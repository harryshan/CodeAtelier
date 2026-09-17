/**
 * 检查 registry 发给模型的函数契约，防止单个非法工具使整轮请求被拒绝。
 * 使用生产 definitions 和 schemas，不调用模型服务，也不执行文件或 Git 操作。
 *
 * 1. 检查根节点为 object、禁止 oneOf，再递归遍历工具定义及数组项，核对 strict 对象的属性均为必填且禁止额外属性。
 * 2. 检查每个新调用的 execution/arguments 调度信封，及唯一 edit_files 工具的 create 分支、带版本/锚点的已有文件补丁、可见空白读取和 run_command 的单一 command 字符串。
 * 3. 检查单一 git 工具的 discriminated action 契约；每个 action 只接受自身所需字段，不能混入任意选项。
 */

import { expect, it } from "vitest";
import {
  definitions,
  schemas,
  parseScheduledToolArguments,
  parseToolArguments,
} from "../src/tools/registry.js";

it("declares every property as required for strict function tools", () => {
  for (const definition of definitions) {
    const parameters = definition.parameters;

    expect(definition.strict).toBe(true);
    expect(parameters.type, definition.name).toBe("object");
    expect(parameters).not.toHaveProperty("oneOf");
    expect(parameters).not.toHaveProperty("anyOf");
    const check = (schema: any) => {
      if (!schema || typeof schema !== "object") {
        return;
      }

      expect(schema).not.toHaveProperty("oneOf");

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

it("requires a strict DAG execution envelope for new model calls", () => {
  expect(
    parseScheduledToolArguments(
      "read_file",
      {
        execution: { id: "read-source", dependsOn: [] },
        arguments: { path: "src/app.ts", startLine: 1, endLine: 20 },
      },
      "fallback",
    ),
  ).toEqual({
    execution: { id: "read-source", dependsOn: [] },
    arguments: {
      path: "src/app.ts",
      startLine: 1,
      endLine: 20,
      whitespaceMode: false,
    },
  });
  expect(
    parseScheduledToolArguments(
      "read_file",
      { path: "src/app.ts", startLine: 1, endLine: 20 },
      "fallback",
    ),
  ).toMatchObject({ execution: { id: "fallback", dependsOn: [] } });
  expect(() =>
    parseScheduledToolArguments(
      "read_file",
      {
        execution: { id: "read-source", dependsOn: [], extra: true },
        arguments: { path: "src/app.ts", startLine: 1, endLine: 20 },
      },
      "fallback",
    ),
  ).toThrow();
});

it("exposes only edit_files for file writes and no directory or search tool", () => {
  for (const name of ["edit_file", "list_files", "write_file", "search"]) {
    expect(schemas).not.toHaveProperty(name);
    expect(definitions.map((definition) => definition.name)).not.toContain(
      name,
    );
    expect(() => parseToolArguments(name, {})).toThrow("未知工具");
  }

  expect(
    schemas.edit_files.parse({
      files: [
        { path: "src/new.ts", create: true, content: "export {};\n" },
        {
          path: "src/app.ts",
          create: false,
          edits: [
            {
              oldText: "old",
              newText: "new",
              startLine: null,
              endLine: null,
              beforeContext: null,
              afterContext: null,
            },
          ],
        },
      ],
    }),
  ).toMatchObject({
    files: [
      { path: "src/new.ts", create: true },
      { path: "src/app.ts", create: false, fileVersion: null },
    ],
  });
  expect(
    schemas.read_file.parse({ path: "src/app.ts", startLine: 1, endLine: 2 }),
  ).toMatchObject({ whitespaceMode: false });
  for (const invalid of [
    { path: "src/new.ts", create: true, edits: [] },
    { path: "src/app.ts", create: false, content: "replace" },
    { path: "src/app.ts", edits: [] },
  ]) {
    expect(schemas.edit_files.safeParse({ files: [invalid] }).success).toBe(
      false,
    );
  }
});

it("accepts only one direct command string for run_command", () => {
  const runCommand = definitions.find(
    (definition) => definition.name === "run_command",
  );

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
  expect(runCommand?.description).toContain(
    "Provide the command to run directly",
  );
  expect(runCommand?.description).toContain("environment-detected");
  expect(runCommand?.description).toContain("multiple keywords");
  expect(runCommand?.description).toContain("`pwsh -Command`");
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

it("normalizes wrapped Git actions while rejecting extra or invalid fields", () => {
  for (const request of [
    { action: "status" },
    { action: "diff", staged: false, paths: [], contextLines: 0 },
    { action: "commit", message: "fix", paths: ["src/app.ts"] },
  ]) {
    expect(parseToolArguments("git", { request })).toEqual(request);
    expect(parseToolArguments("git", request)).toEqual(request);
  }

  for (const raw of [
    { request: { action: "push", force: true } },
    { request: { action: "status" }, force: true },
    { request: { action: "commit", message: "fix", paths: [] } },
    { request: { action: "reset" } },
  ]) {
    expect(() => parseToolArguments("git", raw)).toThrow();
  }
});

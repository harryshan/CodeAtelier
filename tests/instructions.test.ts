/**
 * 验证 Engine 与 Runtime 共用的项目指令加载，不调用真实模型或执行项目内容。
 * 1. 在临时工作区写入根规则，检查来源标记、完整正文及后续调用刷新。
 * 2. 覆盖空文件、缺失、超限和非普通文件，避免把未加载内容标为已阅读。
 * 3. afterEach 删除测试创建的目录；这些断言验证注入结果，不证明模型遵循提示词。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createInstructions } from "../src/agent/instructions.js";

const roots: string[] = [];

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "instructions-"));
  roots.push(root);

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each([false, true])(
  "injects complete current root guidance (runtime=%s)",
  async (runtime) => {
    const root = await workspace();
    const file = path.join(root, "AGENTS.md");
    await writeFile(file, "Unique project rule: 保留正文。\n");

    const first = await createInstructions(root, [], runtime);
    expect(first).toContain(`Project guidance source: ${JSON.stringify(file)}`);
    expect(first).toContain("Status: fully loaded for this task");
    expect(first.split("Unique project rule: 保留正文。\n")).toHaveLength(2);

    await writeFile(file, "Updated project rule.");
    const next = await createInstructions(root, [], runtime);
    expect(next).toContain("Updated project rule.");
    expect(next).not.toContain("Unique project rule:");
  },
);

it("distinguishes an empty loaded file from unavailable guidance", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "AGENTS.md"), "");
  expect(await createInstructions(root, [])).toContain(
    "Status: fully loaded for this task",
  );
});

it.each(["missing", "oversized", "directory"])(
  "does not claim %s guidance was loaded",
  async (kind) => {
    const root = await workspace();
    const file = path.join(root, "AGENTS.md");
    if (kind === "oversized") {
      await writeFile(file, "x".repeat(32001));
    } else if (kind === "directory") {
      await mkdir(file);
    }

    const instructions = await createInstructions(root, []);
    expect(instructions).toContain("Status: not loaded");
    expect(instructions).not.toContain("Status: fully loaded");
    expect(instructions).not.toContain("x".repeat(32001));
  },
);

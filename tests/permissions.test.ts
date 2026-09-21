/**
 * 检查 ApprovalManager 如何批准、拒绝、取消，以及复用会话授权。
 * 命令指纹相关用例通过 fileFixture 运行真实工具。
 *
 * 1. 一次批准只放行对应请求，不能解开其他等待中的操作。
 * 2. 会话授权必须同时匹配 sessionId 和 grantKey；不支持复用的请求不能选择会话批准。
 * 3. 已取消的操作不进入待审批列表，并检查等待期间的授权变化。
 * 4. 工作区内容变化后，同一验证命令需要重新审批；sudo、runas 和直接 git 命令在审批前就被拒绝。
 *
 * 不能只按命令名称复用权限，文件变化后旧指纹对应的授权必须失效。
 */

import { it, expect, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ApprovalManager } from "../src/permissions/approval-manager.js";
import { fileFixture } from "./fixtures/helpers.js";

const data = {
  sessionId: "s",
  taskId: "t",
  tool: "command",
  description: "test",
};

it("one-time approval is consumed and cannot resolve another request", async () => {
  const manager = new ApprovalManager(() => {});
  const signal = new AbortController().signal;
  const first = manager.request(data, signal, "fingerprint");
  const id = manager.list()[0].id;

  manager.decide(id, "once");

  expect(await first).toBe(true);
  expect(() => manager.decide(id, "once")).toThrow("失效");
  const next = manager.request(data, signal, "fingerprint");

  expect(manager.list()).toHaveLength(1);
  manager.decide(manager.list()[0].id, "deny");

  expect(await next).toBe(false);
});

it("session grants are scoped to session and exact grant key", async () => {
  const manager = new ApprovalManager(() => {});
  const signal = new AbortController().signal;
  const first = manager.request(data, signal, "v1");

  manager.decide(manager.list()[0].id, "session");

  expect(await first).toBe(true);
  expect(await manager.request(data, signal, "v1")).toBe(true);
  expect(manager.list()).toEqual([]);
  for (const [sessionId, key] of [
    ["other", "v1"],
    ["s", "v2"],
  ]) {
    const pending = manager.request({ ...data, sessionId }, signal, key);

    expect(manager.list()).toHaveLength(1);
    manager.decide(manager.list()[0].id, "deny");

    expect(await pending).toBe(false);
  }
});

it("nonrepeatable requests reject session grants and remain pending", async () => {
  const manager = new ApprovalManager(() => {});
  const pending = manager.request(data, new AbortController().signal);
  const id = manager.list()[0].id;

  expect(() => manager.decide(id, "session")).toThrow("不支持");
  expect(manager.list()).toHaveLength(1);
  manager.decide(id, "deny");

  expect(await pending).toBe(false);
});

it("forces human review for an expanded sandbox capability", async () => {
  const classify = vi.fn(async () => ({
    decision: "approve" as const,
    reason: "would normally auto approve",
  }));
  const manager = new ApprovalManager(() => {}, classify);
  const pending = manager.request(
    { ...data, tool: "run_with_permissions" },
    new AbortController().signal,
    undefined,
    { requireHuman: true },
  );

  expect(classify).not.toHaveBeenCalled();
  expect(manager.list()).toMatchObject([
    {
      tool: "run_with_permissions",
      reviewReason: "扩展 Sandbox 权限必须由用户人工确认。",
    },
  ]);
  manager.decide(manager.list()[0].id, "deny");
  await expect(pending).resolves.toBe(false);
});

it("already aborted signals never register approvals", async () => {
  const manager = new ApprovalManager(() => {});
  const controller = new AbortController();

  controller.abort();

  await expect(manager.request(data, controller.signal)).rejects.toThrow();
  expect(manager.list()).toEqual([]);
});

it("validation command grants expire after project content changes", async () => {
  const { root, runner, approvals } = await fileFixture();

  await writeFile(path.join(root, "test.test.js"), 'console.log("VALIDATED")');
  const args = { command: "node --test" };
  const first = runner.execute("run_command", args);

  await expect.poll(() => approvals.list().length).toBe(1);
  expect(approvals.list()[0].repeatable).toBe(true);
  approvals.decide(approvals.list()[0].id, "session");

  expect((await first).exitCode).toBe(0);
  expect((await runner.execute("run_command", args)).exitCode).toBe(0);
  expect(approvals.list()).toEqual([]);
  await writeFile(path.join(root, "test.test.js"), 'console.log("CHANGED")');
  const changed = runner.execute("run_command", args);

  await expect.poll(() => approvals.list().length).toBe(1);
  approvals.decide(approvals.list()[0].id, "deny");

  await expect(changed).rejects.toThrow("拒绝");
});

it.each(["sudo", "runas", "git", "echo ok && git status"])(
  "blocks prohibited direct command %s before approval",
  async (command) => {
    const { runner, approvals } = await fileFixture();

    await expect(
      runner.execute("run_command", {
        command: command === "git" ? "git push" : command,
      }),
    ).rejects.toThrow();
    expect(approvals.list()).toEqual([]);
  },
);

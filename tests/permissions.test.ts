import { it, expect } from "vitest";
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
  const args = { command: "node", args: ["--test"], cwd: "." };
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

it.each(["sudo", "runas", "git"])(
  "blocks prohibited direct command %s before approval",
  async (command) => {
    const { runner, approvals } = await fileFixture();

    await expect(
      runner.execute("run_command", { command, args: ["push"], cwd: "." }),
    ).rejects.toThrow();
    expect(approvals.list()).toEqual([]);
  },
);

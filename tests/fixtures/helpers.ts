import { afterEach } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config } from "../../src/config/config.js";
import { ToolRunner } from "../../src/tools/tool-runner.js";
import { ApprovalManager } from "../../src/permissions/approval-manager.js";

const directories: string[] = [];

export async function temp() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ca-test-")),
  );

  directories.push(directory);

  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

export async function fileFixture() {
  const root = await temp();
  const config = new Config(await temp());
  const controller = new AbortController();
  const approvals = new ApprovalManager(() => {});
  const events: { type: string; data: any }[] = [];
  const runner = new ToolRunner({
    root,
    settings: config.settings,
    sessionId: "s",
    taskId: "t",
    signal: controller.signal,
    approvals,
    emit: (type, data) => events.push({ type, data }),
  });

  return { root, config, controller, approvals, events, runner };
}

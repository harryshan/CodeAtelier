/**
 * 验证单账户 Windows Sandbox 的 generation、并发 lease 与共享 ACL grant 引用状态机。
 * 测试只操作内存账本，不创建账户、进程、ACL 或 WFP 规则。
 *
 * 1. 不同工作区在上限内可并发，同一工作区与超限请求拒绝。
 * 2. 相同只读对象跨 manifest 只安装一次，并仅在最后一个租约释放时撤销。
 * 3. epoch/manifest 重放拒绝，账本不一致会 quarantine 整个 generation。
 */

import { expect, it } from "vitest";
import type { AccessManifest } from "../src/sandbox/supervisor-protocol.js";
import { AccountGenerationRegistry } from "../src/sandbox/account-generation.js";

const digest = (character: string) => character.repeat(64);
const root = (id: string, character: string) => ({
  rootId: id,
  path: `C:\\sandbox\\${id}`,
  objectIdentityDigest: digest(character),
});

function manifest(
  workspace: string,
  workspaceCharacter: string,
): AccessManifest {
  return {
    manifestDigest: digest(workspaceCharacter),
    workspaceRootId: workspace,
    readRoots: [root("shared-runtime", "f")],
    writeRoots: [root(workspace, workspaceCharacter)],
    gitConfigFiles: [],
  };
}

it("allows bounded different-workspace concurrency and reference-counts grants", () => {
  const registry = new AccountGenerationRegistry(digest("a"), 2);
  const firstManifest = manifest("workspace-a", "b");
  const secondManifest = manifest("workspace-b", "c");
  const first = registry.acquire({
    executionInstanceId: "instance-a",
    kind: "agent-runtime",
    taskId: "task-a",
    accessManifest: firstManifest,
  });
  const second = registry.acquire({
    executionInstanceId: "instance-b",
    kind: "agent-runtime",
    taskId: "task-b",
    accessManifest: secondManifest,
  });

  expect(first.install).toHaveLength(2);
  expect(second.install).toHaveLength(1);
  expect(second.lease.epoch).toBe(first.lease.epoch + 1);
  expect(registry.snapshot()).toMatchObject({
    state: "healthy",
    activeInstanceCount: 2,
    grantCount: 3,
  });
  expect(() =>
    registry.acquire({
      executionInstanceId: "instance-c",
      kind: "agent-runtime",
      taskId: "task-c",
      accessManifest: manifest("workspace-c", "d"),
    }),
  ).toThrow("并发上限");

  const firstRelease = registry.releaseWithManifest(
    "instance-a",
    first.lease.epoch,
    firstManifest,
  );
  expect(firstRelease.revoke).toEqual([
    expect.objectContaining({
      objectIdentityDigest: digest("b"),
      mode: "write",
    }),
  ]);
  const secondRelease = registry.releaseWithManifest(
    "instance-b",
    second.lease.epoch,
    secondManifest,
  );
  expect(secondRelease.revoke).toHaveLength(2);
  expect(secondRelease.generationEmpty).toBe(true);
});

it("serializes the same workspace even when capacity remains", () => {
  const registry = new AccountGenerationRegistry(digest("a"), 4);
  const accessManifest = manifest("workspace-a", "b");
  registry.acquire({
    executionInstanceId: "instance-a",
    kind: "agent-runtime",
    taskId: "task-a",
    accessManifest,
  });

  expect(() =>
    registry.acquire({
      executionInstanceId: "instance-b",
      kind: "agent-runtime",
      taskId: "task-b",
      accessManifest,
    }),
  ).toThrow("同一工作区");
});

it("rejects stale release and quarantines inconsistent grant state", () => {
  const registry = new AccountGenerationRegistry(digest("a"), 2);
  const accessManifest = manifest("workspace-a", "b");
  const acquired = registry.acquire({
    executionInstanceId: "instance-a",
    kind: "push-runner",
    taskId: "task-a",
    accessManifest,
  });

  expect(() =>
    registry.releaseWithManifest(
      "instance-a",
      acquired.lease.epoch + 1,
      accessManifest,
    ),
  ).toThrow("不匹配");
  expect(
    registry
      .quarantine("process_unknown")
      .map((lease) => lease.executionInstanceId),
  ).toEqual(["instance-a"]);
  expect(registry.snapshot()).toMatchObject({
    state: "quarantined",
    quarantineCategory: "process_unknown",
  });
  expect(() =>
    registry.acquire({
      executionInstanceId: "instance-b",
      kind: "agent-runtime",
      taskId: "task-b",
      accessManifest: manifest("workspace-b", "c"),
    }),
  ).toThrow("停止发放");
});

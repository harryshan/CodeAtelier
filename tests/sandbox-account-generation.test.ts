/**
 * 验证单账户 Windows Sandbox 的 generation、并发 lease 与共享 ACL grant 引用状态机。
 * 测试只操作内存账本，不创建账户、进程、ACL 或 WFP 规则。
 *
 * 1. 不同工作区在上限内可并发，同一工作区与超限请求拒绝；同任务阻塞的 Runtime 可重叠一个 Push Runner。
 * 2. 相同只读对象跨 manifest 只安装一次；后继 lease 等待首个原生 provision 完成。
 * 3. release 在原生撤销成功前保留 lease/grant，commit 后才减少引用并在最后一个 lease 撤销。
 * 4. epoch/manifest 重放拒绝，账本不一致会 quarantine 整个 generation。
 */

import { expect, it } from "vitest";
import type { AccessManifest } from "../src/sandbox/supervisor-protocol.js";
import { AccountGenerationRegistry } from "../src/sandbox/account-generation.js";

const digest = (character: string) => character.repeat(64);
const root = (id: string, character: string) => ({
  rootId: id,
  path: `C:\\sandbox\\${id}`,
  objectIdentityDigest: digest(character),
  deviceId: "1",
  fileId: character.charCodeAt(0).toString(),
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

it("allows bounded different-workspace concurrency and reference-counts grants", async () => {
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
  let secondReady = false;
  const waiting = second.waitForSharedProvision().then(() => {
    secondReady = true;
  });
  await Promise.resolve();
  expect(secondReady).toBe(false);
  registry.markProvisioned("instance-a", first.lease.epoch);
  await waiting;
  expect(secondReady).toBe(true);
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

  const firstRelease = registry.prepareReleaseWithManifest(
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
  expect(registry.snapshot().activeInstanceCount).toBe(2);
  registry.commitRelease(firstRelease.releaseId, firstManifest);
  const secondRelease = registry.prepareReleaseWithManifest(
    "instance-b",
    second.lease.epoch,
    secondManifest,
  );
  expect(secondRelease.revoke).toHaveLength(2);
  registry.commitRelease(secondRelease.releaseId, secondManifest);
  expect(registry.snapshot().activeInstanceCount).toBe(0);
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

it("allows one push runner beside its blocked agent runtime", async () => {
  const registry = new AccountGenerationRegistry(digest("a"), 1);
  const accessManifest = manifest("workspace-a", "b");
  const runtime = registry.acquire({
    executionInstanceId: "runtime-a",
    kind: "agent-runtime",
    taskId: "task-a",
    accessManifest,
  });
  registry.markProvisioned("runtime-a", runtime.lease.epoch);
  const push = registry.acquire({
    executionInstanceId: "push-a",
    kind: "push-runner",
    taskId: "task-a",
    accessManifest,
  });

  await expect(push.waitForSharedProvision()).resolves.toBeUndefined();
  expect(push.install).toHaveLength(0);
  expect(registry.snapshot().activeInstanceCount).toBe(2);
  expect(() =>
    registry.acquire({
      executionInstanceId: "push-b",
      kind: "push-runner",
      taskId: "task-a",
      accessManifest,
    }),
  ).toThrow("并发上限");
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
    registry.prepareReleaseWithManifest(
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

it("keeps the lease and grants when native revocation is not committed", () => {
  const registry = new AccountGenerationRegistry(digest("a"), 2);
  const accessManifest = manifest("workspace-a", "b");
  const acquired = registry.acquire({
    executionInstanceId: "instance-a",
    kind: "agent-runtime",
    taskId: "task-a",
    accessManifest,
  });
  registry.markProvisioned("instance-a", acquired.lease.epoch);

  const release = registry.prepareReleaseWithManifest(
    "instance-a",
    acquired.lease.epoch,
    accessManifest,
  );
  registry.abortRelease(release.releaseId);
  registry.quarantine("acl_cleanup");

  expect(registry.snapshot()).toMatchObject({
    state: "quarantined",
    activeInstanceCount: 1,
    grantCount: 2,
    quarantineCategory: "acl_cleanup",
  });
});

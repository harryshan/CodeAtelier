/**
 * 管理单一 Windows Sandbox 账户 generation 的并发实例租约与共享 ACL grant 引用。
 * SandboxBroker 在原生 provision 前取得 lease，在 Job、代理与 ACL 全部清理后释放；恢复代码读取快照判断能否继续复用账户。
 *
 * 1. acquire 强制 1～4 个不同任务工作区并发、同一规范工作区串行；同任务可在 Agent Runtime 阻塞期间重叠一个 Push Runner 或 capability runner，并为每个实例分配单调 lease epoch。
 * 2. grant table 以对象身份和访问模式计数；acquire 先完整预检再提交引用，首个引用进入 provisioning，后继 lease 必须等待原生安装完成。
 * 3. release 使用 prepare/commit 两阶段协议；原生撤销失败前不删除 lease 或 grant，防止 orphan 从账本消失。
 * 4. quarantine 在未知进程、ACL、代理或凭据状态下冻结 generation，并返回所有仍需终止和对账的实例。
 * 5. snapshot 只暴露摘要和计数，可写入 session/log/trace；不包含原始路径、SID、命令或凭据。
 *
 * 本模块不执行进程或 ACL 操作。调用方只有在原生层证明 release 返回的清理全部成功后，才能把 lease 视为 clean。
 */

import { randomUUID } from "node:crypto";
import type { AccessManifest } from "./supervisor-protocol.js";

export type AccountGenerationState = "healthy" | "draining" | "quarantined";

export interface SandboxInstanceLease {
  executionInstanceId: string;
  kind: "agent-runtime" | "push-runner" | "capability-runner";
  taskId: string;
  workspaceRootId: string;
  manifestDigest: string;
  epoch: number;
}

interface GrantReference {
  objectIdentityDigest: string;
  mode: "read" | "write";
  references: number;
  provisionState: "provisioning" | "installed" | "failed";
  installerExecutionInstanceId: string;
  waiters: Array<{
    resolve: () => void;
    reject: (error: AccountGenerationError) => void;
  }>;
}

export interface AccountGenerationRelease {
  releaseId: string;
  lease: SandboxInstanceLease;
  revoke: Array<Pick<GrantReference, "objectIdentityDigest" | "mode">>;
}

export interface AccountGenerationSnapshot {
  generationId: string;
  generationDigest: string;
  state: AccountGenerationState;
  nextLeaseEpoch: number;
  activeInstanceCount: number;
  activeInstances: Array<
    Pick<
      SandboxInstanceLease,
      | "executionInstanceId"
      | "kind"
      | "workspaceRootId"
      | "manifestDigest"
      | "epoch"
    >
  >;
  grantCount: number;
  quarantineCategory?: SandboxGenerationFailure;
}

export type SandboxGenerationFailure =
  | "process_unknown"
  | "acl_cleanup"
  | "proxy_cleanup"
  | "credential_cleanup"
  | "identity_mismatch"
  | "ledger_inconsistent";

export class AccountGenerationError extends Error {
  readonly code = "SANDBOX_ACCOUNT_GENERATION";

  constructor(reason: string) {
    super(`Sandbox account generation 拒绝操作：${reason}`);
    this.name = "AccountGenerationError";
  }
}

function grantKey(identity: string, mode: "read" | "write") {
  return `${mode}:${identity}`;
}

function manifestGrants(manifest: AccessManifest) {
  return [
    ...manifest.readRoots.map((root) => ({
      objectIdentityDigest: root.objectIdentityDigest,
      mode: "read" as const,
    })),
    ...manifest.gitConfigFiles.map((root) => ({
      objectIdentityDigest: root.objectIdentityDigest,
      mode: "read" as const,
    })),
    ...manifest.writeRoots.map((root) => ({
      objectIdentityDigest: root.objectIdentityDigest,
      mode: "write" as const,
    })),
  ];
}

export class AccountGenerationRegistry {
  readonly generationId = randomUUID();
  private state: AccountGenerationState = "healthy";
  private nextLeaseEpoch = 1;
  private active = new Map<string, SandboxInstanceLease>();
  private grants = new Map<string, GrantReference>();
  private pendingReleases = new Map<string, AccountGenerationRelease>();
  private quarantineCategory?: SandboxGenerationFailure;

  constructor(
    readonly generationDigest: string,
    private maximumConcurrentInstances: number,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(generationDigest) ||
      !Number.isInteger(maximumConcurrentInstances) ||
      maximumConcurrentInstances < 1 ||
      maximumConcurrentInstances > 4
    ) {
      throw new AccountGenerationError("generation 摘要或并发上限无效。");
    }
  }

  acquire(input: {
    executionInstanceId: string;
    kind: "agent-runtime" | "push-runner" | "capability-runner";
    taskId: string;
    accessManifest: AccessManifest;
  }) {
    if (this.state !== "healthy") {
      throw new AccountGenerationError("generation 已停止发放新租约。");
    }

    if (this.active.has(input.executionInstanceId)) {
      throw new AccountGenerationError("execution instance 已持有租约。");
    }

    const active = [...this.active.values()];
    const sameTask = active.filter((lease) => lease.taskId === input.taskId);
    const nestedCapabilityRunner =
      input.kind !== "agent-runtime" &&
      sameTask.some(
        (lease) =>
          lease.kind === "agent-runtime" &&
          lease.workspaceRootId === input.accessManifest.workspaceRootId,
      ) &&
      !sameTask.some((lease) => lease.kind !== "agent-runtime");
    const activeTasks = new Set(active.map((lease) => lease.taskId));

    if (
      !nestedCapabilityRunner &&
      activeTasks.size >= this.maximumConcurrentInstances
    ) {
      throw new AccountGenerationError("已达到 Sandbox 并发上限。");
    }

    if (
      !nestedCapabilityRunner &&
      active.some(
        (lease) =>
          lease.workspaceRootId === input.accessManifest.workspaceRootId,
      )
    ) {
      throw new AccountGenerationError("同一工作区已有活动 Sandbox 实例。");
    }

    const lease: SandboxInstanceLease = Object.freeze({
      executionInstanceId: input.executionInstanceId,
      kind: input.kind,
      taskId: input.taskId,
      workspaceRootId: input.accessManifest.workspaceRootId,
      manifestDigest: input.accessManifest.manifestDigest,
      epoch: this.nextLeaseEpoch++,
    });
    const install: Array<
      Pick<GrantReference, "objectIdentityDigest" | "mode">
    > = [];
    const waits: Promise<void>[] = [];
    const requestedGrants = manifestGrants(input.accessManifest);

    for (const grant of requestedGrants) {
      const current = this.grants.get(
        grantKey(grant.objectIdentityDigest, grant.mode),
      );
      if (current?.provisionState === "failed") {
        throw new AccountGenerationError("共享 ACL grant 安装已经失败。");
      }
    }

    for (const grant of requestedGrants) {
      const key = grantKey(grant.objectIdentityDigest, grant.mode);
      const current = this.grants.get(key);

      if (current) {
        current.references += 1;
        if (current.provisionState === "provisioning") {
          waits.push(
            new Promise<void>((resolve, reject) => {
              current.waiters.push({ resolve, reject });
            }),
          );
        }
      } else {
        const reference: GrantReference = {
          ...grant,
          references: 1,
          provisionState: "provisioning",
          installerExecutionInstanceId: lease.executionInstanceId,
          waiters: [],
        };
        this.grants.set(key, reference);
        install.push({
          objectIdentityDigest: reference.objectIdentityDigest,
          mode: reference.mode,
        });
      }
    }

    this.active.set(lease.executionInstanceId, lease);

    return {
      lease,
      install,
      waitForSharedProvision: () => Promise.all(waits).then(() => undefined),
    };
  }

  markProvisioned(executionInstanceId: string, epoch: number) {
    const lease = this.requireLease(executionInstanceId, epoch);

    for (const grant of this.grants.values()) {
      if (
        grant.installerExecutionInstanceId !== lease.executionInstanceId ||
        grant.provisionState !== "provisioning"
      ) {
        continue;
      }

      grant.provisionState = "installed";
      for (const waiter of grant.waiters.splice(0)) {
        waiter.resolve();
      }
    }
  }

  markProvisionFailed(executionInstanceId: string, epoch: number) {
    const lease = this.requireLease(executionInstanceId, epoch);
    const error = new AccountGenerationError("共享 ACL grant 安装未能完成。");

    for (const grant of this.grants.values()) {
      if (
        grant.installerExecutionInstanceId !== lease.executionInstanceId ||
        grant.provisionState !== "provisioning"
      ) {
        continue;
      }

      grant.provisionState = "failed";
      for (const waiter of grant.waiters.splice(0)) {
        waiter.reject(error);
      }
    }
  }

  /** Runtime 尚未调用时可无原生副作用地回滚 acquire；已安装的 grant 必须走两阶段 release。 */
  rollbackAcquire(
    executionInstanceId: string,
    epoch: number,
    manifest: AccessManifest,
  ) {
    const lease = this.requireLease(executionInstanceId, epoch);
    if (lease.manifestDigest !== manifest.manifestDigest) {
      throw new AccountGenerationError("回滚租约与 AccessManifest 不匹配。");
    }

    for (const grant of manifestGrants(manifest)) {
      const key = grantKey(grant.objectIdentityDigest, grant.mode);
      const current = this.grants.get(key);
      if (!current || current.references < 1) {
        this.quarantine("ledger_inconsistent");
        throw new AccountGenerationError("共享 ACL grant 账本不一致。");
      }

      current.references -= 1;
      if (current.references === 0) {
        if (current.provisionState === "installed") {
          this.quarantine("ledger_inconsistent");
          throw new AccountGenerationError(
            "已安装 grant 不能按未启动路径回滚。",
          );
        }

        this.grants.delete(key);
      }
    }

    this.active.delete(executionInstanceId);
  }

  beginDrain() {
    if (this.state === "healthy") {
      this.state = "draining";
    }
  }

  private requireLease(executionInstanceId: string, epoch: number) {
    const lease = this.active.get(executionInstanceId);
    if (!lease || lease.epoch !== epoch) {
      throw new AccountGenerationError("租约 epoch 与账本不匹配。");
    }

    return lease;
  }

  /** prepare 只冻结释放意图，不改引用或 active；Broker 必须串行执行 prepare/native revoke/commit。 */
  prepareReleaseWithManifest(
    executionInstanceId: string,
    epoch: number,
    manifest: AccessManifest,
  ) {
    const lease = this.active.get(executionInstanceId);
    if (
      !lease ||
      lease.epoch !== epoch ||
      lease.manifestDigest !== manifest.manifestDigest
    ) {
      throw new AccountGenerationError("租约与 AccessManifest 账本不匹配。");
    }

    if (
      [...this.pendingReleases.values()].some(
        (release) => release.lease.executionInstanceId === executionInstanceId,
      )
    ) {
      throw new AccountGenerationError("租约已经在等待原生清理提交。");
    }

    const revoke: AccountGenerationRelease["revoke"] = [];
    for (const grant of manifestGrants(manifest)) {
      const key = grantKey(grant.objectIdentityDigest, grant.mode);
      const current = this.grants.get(key);

      if (!current || current.references < 1) {
        this.quarantine("ledger_inconsistent");
        throw new AccountGenerationError("共享 ACL grant 账本不一致。");
      }

      if (current.references === 1) {
        revoke.push({
          objectIdentityDigest: current.objectIdentityDigest,
          mode: current.mode,
        });
      }
    }

    const release = {
      releaseId: randomUUID(),
      lease,
      revoke,
    };
    this.pendingReleases.set(release.releaseId, release);

    return release;
  }

  commitRelease(releaseId: string, manifest: AccessManifest) {
    const release = this.pendingReleases.get(releaseId);
    if (!release || release.lease.manifestDigest !== manifest.manifestDigest) {
      throw new AccountGenerationError(
        "释放提交与 AccessManifest 账本不匹配。",
      );
    }

    for (const grant of manifestGrants(manifest)) {
      const key = grantKey(grant.objectIdentityDigest, grant.mode);
      const current = this.grants.get(key);
      if (!current || current.references < 1) {
        this.quarantine("ledger_inconsistent");
        throw new AccountGenerationError("共享 ACL grant 账本不一致。");
      }

      current.references -= 1;
      if (current.references === 0) {
        this.grants.delete(key);
      }
    }

    this.active.delete(release.lease.executionInstanceId);
    this.pendingReleases.delete(releaseId);

    return { lease: release.lease, generationEmpty: this.active.size === 0 };
  }

  abortRelease(releaseId: string) {
    this.pendingReleases.delete(releaseId);
  }

  quarantine(category: SandboxGenerationFailure) {
    this.state = "quarantined";
    this.quarantineCategory ??= category;

    return [...this.active.values()];
  }

  snapshot(): AccountGenerationSnapshot {
    return {
      generationId: this.generationId,
      generationDigest: this.generationDigest,
      state: this.state,
      nextLeaseEpoch: this.nextLeaseEpoch,
      activeInstanceCount: this.active.size,
      activeInstances: [...this.active.values()].map((lease) => ({
        executionInstanceId: lease.executionInstanceId,
        kind: lease.kind,
        workspaceRootId: lease.workspaceRootId,
        manifestDigest: lease.manifestDigest,
        epoch: lease.epoch,
      })),
      grantCount: this.grants.size,
      quarantineCategory: this.quarantineCategory,
    };
  }
}

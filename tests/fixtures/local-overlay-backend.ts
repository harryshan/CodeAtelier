/**
 * Local overlay 生命周期/API 测试的文件系统替身，不提供真实挂载或 OS Sandbox 证据。
 * 1. workspace/idFor 固定临时目录身份；open 使用实际目录并记录挂载次数，拒绝重复打开。
 * 2. finish 记录传入发布计划、推进观察周期并卸载，不执行候选验证或写入来源。
 * 3. failOpen/failFinish 为失败保留回归提供明确注入点；持久清单/锁/Store 均由生产代码处理。
 * 4. recoverAccess 只模拟根 ACL 恢复期间的挂载生命周期，不证明真实文件访问限制。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LocalOverlayBackend } from "../../src/local-overlays/backend.js";
import type { FrozenPublication } from "../../src/local-overlays/publication.js";
import { directoryIdentity } from "../../src/worktrees/git.js";

export class FakeLocalOverlayBackend implements LocalOverlayBackend {
  readonly mounted = new Set<string>();
  readonly epochs = new Map<string, number>();
  readonly publications: FrozenPublication[] = [];
  creates = 0;
  failOpen = false;
  failFinish = false;

  constructor(readonly root: string) {}

  workspace(id: string) {
    return path.join(this.root, id);
  }

  idFor(workspace: string) {
    return path.dirname(workspace) === this.root
      ? path.basename(workspace)
      : undefined;
  }

  async recoverAccess(
    id: string,
    source: string,
    control: string,
    signal: AbortSignal,
  ) {
    const mount = await this.open(id, source, control, false, signal);

    return { identity: mount.identity, close: mount.close };
  }

  async open(
    id: string,
    _source: string,
    control: string,
    create: boolean,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.failOpen) {
      throw new Error("mount failed");
    }

    if (this.mounted.has(id)) {
      throw new Error("already mounted");
    }

    if (create) {
      this.creates++;
      await mkdir(control);
      await mkdir(this.workspace(id));
    }

    this.mounted.add(id);

    return {
      identity: () => directoryIdentity(this.workspace(id)),
      close: async () => {
        this.mounted.delete(id);
      },
      finish: async (_taskId: string, publication?: FrozenPublication) => {
        if (this.failFinish) {
          throw new Error("freeze failed");
        }

        if (publication) {
          this.publications.push(publication);
        }

        const epoch = (this.epochs.get(id) ?? 0) + 1;
        this.epochs.set(id, epoch);
        this.mounted.delete(id);

        return { epoch, capturedPaths: 1 };
      },
    };
  }
}

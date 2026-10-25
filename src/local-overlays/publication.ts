/**
 * 把任务明确选择绑定到冻结视图和来源级 Publisher，供 WinFsp backend 收尾调用。
 * 1. selection 校验有界相对路径及必需的候选验证器；函数仅由可信 Engine 集成层提供，不反序列化代码。
 * 2. publishFrozen 在 helper 租约内导出 B/O/读依赖，先持久 publishing 批次关联，再验证并发布。
 * 3. 仅已排空且未开始来源写入的拒绝返回 rejected；unknown 或完成后确认缺失抛出并保留恢复现场。
 * 4. 成功确认释放所选覆盖，未选内容继续私有；不选择全部 upper，不调用 Git，不自建验证执行权限。
 * 当前接口是内部接线边界；模型选择工具、候选工程 Sandbox 执行器和公开 UI 仍须另外接入。
 */
import type { Logger } from "pino";
import { z } from "zod";
import type { OverlayAcknowledgement } from "../worktrees/overlay.js";
import { checkRelative, sourceIdentity } from "./publication/files.js";
import { nativeBatch } from "./publication/native-batch.js";
import { PublishError } from "./publication/merge.js";
import {
  Publisher,
  PublicationFailure,
  type PublishOptions,
} from "./publication/publisher.js";

export interface PublicationSelection {
  paths: readonly string[];
  validate: PublishOptions["validate"];
}

export const publicationStateSchema = z.object({
  state: z.enum([
    "selected",
    "publishing",
    "published",
    "rejected",
    "retained",
  ]),
  paths: z.array(z.string()).max(100),
  batchId: z.uuid().optional(),
  files: z.number().int().nonnegative().optional(),
  reason: z.string().max(128).optional(),
  cleanupPending: z.number().int().nonnegative().optional(),
});
export type PublicationState = z.infer<typeof publicationStateSchema>;

export interface FrozenPublication extends PublicationSelection {
  signal: AbortSignal;
  record(state: PublicationState): Promise<void>;
}

export function publicationSelection(
  input: PublicationSelection,
): PublicationSelection {
  const paths = z.array(z.string()).min(1).max(100).parse(input.paths);
  const keys = new Set<string>();
  for (const file of paths) {
    checkRelative(file);
    const key = file.toLowerCase();
    if (keys.has(key)) {
      throw new PublishError("DUPLICATE_PATH");
    }

    keys.add(key);
  }

  if (typeof input.validate !== "function") {
    throw new PublishError("VALIDATOR_REQUIRED");
  }

  return { paths, validate: input.validate };
}

export async function publishFrozen(input: {
  directory: string;
  source: string;
  control: string;
  log: Logger;
  plan: FrozenPublication;
  signal: AbortSignal;
  verify(epochs?: readonly number[]): Promise<void>;
  acknowledge(request: OverlayAcknowledgement): Promise<void>;
}): Promise<PublicationState> {
  const paths = [...input.plan.paths];
  const signal = AbortSignal.any([input.signal, input.plan.signal]);
  let batch: Awaited<ReturnType<typeof nativeBatch>>;
  try {
    signal.throwIfAborted();
    batch = await nativeBatch(
      await sourceIdentity(input.source),
      input.control,
      paths,
      input.verify,
    );
  } catch (error) {
    // Export has no source write side effect. A lost/poisoned frozen lease is
    // still rejected by the enclosing manager before a view can become ready.
    return {
      state: "rejected",
      paths,
      reason: signal.aborted
        ? "CANCELLED"
        : error instanceof PublishError
          ? error.code
          : "EXPORT_REJECTED",
    };
  }

  await input.plan.record({ state: "publishing", paths, batchId: batch.id });
  try {
    const result = await new Publisher(input.directory, input.log).publish(
      batch,
      {
        nativeWindows: true,
        signal,
        validate: input.plan.validate,
        refresh: {
          request: batch.acknowledgement,
          checkpoint: batch.checkpoint,
          acknowledge: input.acknowledge,
        },
      },
    );
    if (result.refreshPending) {
      throw new PublishError("VIEW_REFRESH_PENDING");
    }

    return {
      state: "published",
      paths,
      batchId: batch.id,
      files: result.files,
      cleanupPending: result.cleanupPending,
    };
  } catch (error) {
    if (error instanceof PublicationFailure && error.outcome === "unapplied") {
      return {
        state: "rejected",
        paths,
        batchId: batch.id,
        reason: signal.aborted ? "CANCELLED" : error.reason,
      };
    }

    throw error;
  }
}

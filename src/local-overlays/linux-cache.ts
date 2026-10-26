/**
 * Linux 正常收尾的单轮 lower 缓存回收；仅由 backend 在 Runtime 排空、状态保存及普通卸载后调用。
 * 1. discardLinuxCache 绑定明确 privateRoot/control-UUID 路径和打开时的目录身份，拒绝替换或链接。
 * 2. 只删除该轮 helper 缓存目录；不枚举来源、不删除 upper、round 或历史未知缓存。
 * 3. 调用方持有 Service 生命周期锁和 pending；失败上抛保留 pending，不自动重试或续跑来源写入。
 * 原始 B 已保存到 round，已发布批次的 B 在 Publisher journal 中；本函数不承担保存或卸载证明。
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PublishError } from "./publication/merge.js";
import { sourceIdentity } from "./publication/files.js";

export async function discardLinuxCache(
  privateRoot: string,
  cache: string,
  identity: string,
) {
  const name = path.basename(cache);
  if (
    path.dirname(cache) !== privateRoot ||
    !name.startsWith("control-") ||
    !z.uuid().safeParse(name.slice(8)).success
  ) {
    throw new PublishError("CACHE_PATH_INVALID");
  }

  const current = await sourceIdentity(cache);
  if (current.root !== cache || current.identity !== identity) {
    throw new PublishError("CACHE_REPLACED");
  }

  await rm(cache, { recursive: true });
}

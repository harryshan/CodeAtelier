/**
 * 宿主 Publisher 调用固定 WinFsp helper 的 Windows 发布短命令。
 * 1. windowsReplace 传已核对的路径及前后 SHA-256，要求退出成功和有界结构化收据同时成立。
 * 2. windowsCleanup 仅传完整发布收据记录的备份身份和原文哈希，原生按句柄核对后删除。
 * 3. 超时、非零退出或协议缺失一律不推断副作用缺席；由 Publisher 保留 intent/备份与锁。
 * 路径/正文不进日志或 trace；固定 helper、隐藏窗口、输出上限和执行期限，不回退普通 rename。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { overlayHelperPath } from "../../src/worktrees/overlay.js";
import { PublishError } from "./merge.js";

const execute = promisify(execFile);

async function command(arguments_: string[]) {
  if (process.platform !== "win32") {
    throw new PublishError("WINDOWS_REQUIRED");
  }

  try {
    const result = await execute(overlayHelperPath(), arguments_, {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8192,
    });

    return JSON.parse(result.stdout) as unknown;
  } catch (error: unknown) {
    let nativeStatus: number | undefined;
    let nativeStage: number | undefined;
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      try {
        const result = z
          .object({
            version: z.literal(1),
            error: z.literal("native"),
            status: z.number().int().min(0).max(0xffffffff),
            stage: z.number().int().min(0).max(9).optional(),
          })
          .parse(JSON.parse(error.stdout));
        nativeStatus = result.status;
        nativeStage = result.stage;
      } catch {
        /* Only bounded native status codes are diagnostic data. */
      }
    }

    throw new PublishError("NATIVE_PUBLISH_UNCONFIRMED", {
      cause: { nativeStatus, nativeStage },
    });
  }
}

export async function windowsReplace(
  target: string,
  temporary: string,
  beforeHash: string,
  afterHash: string,
) {
  const result = await command([
    "publish-replace",
    target,
    temporary,
    beforeHash,
    afterHash,
  ]);

  return z
    .object({
      version: z.literal(1),
      state: z.literal("published"),
      backupIdentity: z.string().regex(/^\d{1,10}:\d{1,20}$/),
    })
    .parse(result).backupIdentity;
}

export async function windowsCleanup(
  backup: string,
  identity: string,
  hash: string,
) {
  const result = await command(["publish-cleanup", backup, identity, hash]);
  z.object({ version: z.literal(1), state: z.literal("cleaned") }).parse(
    result,
  );
}

/**
 * WorktreeService 的 Riftri 后端选择与 POSIX 原生 CoW 适配，不调用 immutable-base CLI。
 * 1. nativeHelperPath 固定可信应用产物；Windows 探测 WinFsp v1 长驻 helper，POSIX 验证 v2 snapshot 与同卷能力。
 * 2. createCheckout 只负责 POSIX snapshot；Windows 交给 OverlayManager/overlay-git，不复制来源树和 Git objects。
 * 3. 缺少能力明确拒绝并提示 Worktree；启动后的失败/取消/不可信收据保留现场，不降级或重放。
 * checkoutSchema 保留旧 Git fallback 清单可读；新 Riftri 请求永远不选择 Git。
 */

import { lstat, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { executeProcess } from "../tools/process.js";
import { gitEnvironment } from "./git.js";
import { overlayHelperPath } from "./overlay.js";

export const checkoutSchema = z.object({
  backend: z.enum(["git", "riftri-reflink", "riftri-apfs", "riftri-winfsp"]),
  fallbackReason: z
    .enum([
      "helper-unavailable",
      "unsupported-volume",
      "different-volume",
      "sparse-checkout",
      "no-reusable-files",
    ])
    .optional(),
  clonedFiles: z.number().int().nonnegative().optional(),
});
export type Checkout = z.infer<typeof checkoutSchema>;

function unavailable(reason: string): never {
  throw new Error(
    `Riftri 不可用（${reason}）。请显式选择 Git worktree；不会自动回退。`,
  );
}

export function nativeHelperPath() {
  if (process.platform === "win32") {
    return overlayHelperPath();
  }

  const base = import.meta.url.endsWith(".ts")
    ? "../../dist/native/"
    : "../../native/";

  return fileURLToPath(
    new URL(
      `${base}${process.platform}-${process.arch}/codeatelier-riftri`,
      import.meta.url,
    ),
  );
}

async function helper(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  executable: string,
) {
  const result = await executeProcess(
    executable,
    args,
    cwd,
    signal,
    600_000,
    16_384,
    () => {},
    gitEnvironment(),
  );
  signal.throwIfAborted();
  if (result.exitCode !== 0 || result.truncated) {
    const reasons: Record<string, string> = {
      "git-layout-or-lock": "Git metadata 含外置引用、嵌套仓库或活跃锁",
      "external-link": "目录含指向来源树外的符号链接",
      "source-changed": "创建期间来源文件发生变化，请先停止主目录写入",
      "native-clone": "文件无法完成原生 CoW 克隆",
      "unsupported-entry": "目录含不支持的特殊文件",
      filesystem: "文件系统操作失败",
    };
    let reason = "操作失败或超时";
    try {
      const receipt = z
        .object({ version: z.literal(2), error: z.string() })
        .parse(JSON.parse(result.output));
      reason = Object.hasOwn(reasons, receipt.error)
        ? reasons[receipt.error]!
        : reason;
    } catch {
      // An invalid or truncated result must not turn into a successful fallback.
    }

    throw new Error(`Riftri ${reason}；保留创建现场，不会自动重新创建。`);
  }

  return JSON.parse(result.output);
}

export async function selectCheckout(
  source: string,
  root: string,
  signal: AbortSignal,
  executable = nativeHelperPath(),
): Promise<Checkout> {
  signal.throwIfAborted();
  const info = await lstat(executable).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) {
    return unavailable("缺少原生 helper");
  }

  if (process.platform === "win32" && executable === overlayHelperPath()) {
    const probe = await (async () =>
      z
        .object({ version: z.literal(1), available: z.boolean() })
        .parse(await helper(["probe"], source, signal, executable)))().catch(
      () => {
        signal.throwIfAborted();

        return undefined;
      },
    );

    return probe?.available
      ? { backend: "riftri-winfsp" }
      : unavailable("WinFsp Runtime 未安装、helper 不兼容或无法启动");
  }

  if ((await stat(source)).dev !== (await stat(root)).dev) {
    return unavailable("来源与目标不在同一文件系统");
  }

  const probe = await (async () =>
    z
      .object({
        version: z.literal(2),
        backend: z.enum(["riftri-reflink", "riftri-apfs"]).nullable(),
      })
      .parse(
        await helper(["probe", root], source, signal, executable),
      ))().catch(() => {
    signal.throwIfAborted();

    return undefined;
  });
  if (!probe) {
    return unavailable("helper 版本不兼容或探测失败，请重新构建");
  }

  return probe.backend
    ? { backend: probe.backend }
    : unavailable("当前平台或文件系统不支持原生 CoW");
}

export async function createCheckout(
  source: string,
  destination: string,
  selection: Checkout,
  signal: AbortSignal,
  executable = nativeHelperPath(),
): Promise<Checkout> {
  if (selection.backend === "git" || selection.backend === "riftri-winfsp") {
    return unavailable("Riftri 不能使用 Git 后端");
  }

  const result = z
    .object({
      version: z.literal(2),
      clonedFiles: z.number().int().nonnegative(),
    })
    .parse(
      await helper(
        ["snapshot", source, destination],
        source,
        signal,
        executable,
      ),
    );

  return { ...selection, clonedFiles: result.clonedFiles };
}

/**
 * WorktreeService 的可选 Riftri 存储适配层，不调用上游 immutable-base CLI。
 * 1. nativeHelperPath 固定可信应用产物路径；selectCheckout 探测 helper/目的卷和 Git sparse 配置。
 * 2. createCheckout 保留标准 Git linked metadata，原生 helper 从来源普通文件克隆、校验 blob 并由 Git 补齐缺失项。
 * 3. 未安装/不支持在创建前回退；创建后错误、取消或不可信收据均停止并由服务保留失败清单。
 * 后端及克隆计数是持久诊断数据；原有目录验证、Sandbox 根和任务生命周期不变。
 */

import { lstat, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { executeProcess } from "../tools/process.js";
import { addWorktree, git, gitEnvironment } from "./git.js";

export const checkoutSchema = z.object({
  backend: z.enum(["git", "riftri-reflink", "riftri-apfs"]),
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

export function nativeHelperPath() {
  const base = import.meta.url.endsWith(".ts")
    ? "../../dist/native/"
    : "../../native/";

  return fileURLToPath(
    new URL(
      `${base}${process.platform}-${process.arch}/codeatelier-riftri${process.platform === "win32" ? ".exe" : ""}`,
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
    throw new Error("Riftri 操作失败或超时；保留创建现场，不会自动重新创建。");
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
    return { backend: "git", fallbackReason: "helper-unavailable" };
  }

  if ((await stat(source)).dev !== (await stat(root)).dev) {
    return { backend: "git", fallbackReason: "different-volume" };
  }

  const config = await git(source, ["config", "--null", "--list"], signal);
  if (
    config.split("\0").some((entry) => {
      const [key, value = ""] = entry.split("\n");

      return (
        key === "core.sparsecheckout" &&
        !["false", "no", "off", "0"].includes(value.toLowerCase())
      );
    })
  ) {
    return { backend: "git", fallbackReason: "sparse-checkout" };
  }

  const probe = await (async () =>
    z
      .object({
        version: z.literal(1),
        backend: z.enum(["riftri-reflink", "riftri-apfs"]).nullable(),
      })
      .parse(
        await helper(["probe", root], source, signal, executable),
      ))().catch(() => {
    signal.throwIfAborted();

    return undefined;
  });
  if (!probe) {
    return { backend: "git", fallbackReason: "helper-unavailable" };
  }

  return probe.backend
    ? { backend: probe.backend }
    : { backend: "git", fallbackReason: "unsupported-volume" };
}

export async function createCheckout(
  source: string,
  destination: string,
  commit: string,
  selection: Checkout,
  signal: AbortSignal,
  executable = nativeHelperPath(),
): Promise<Checkout> {
  await addWorktree(
    source,
    destination,
    commit,
    signal,
    selection.backend !== "git",
  );
  if (selection.backend === "git") {
    return selection;
  }

  await git(destination, ["read-tree", commit], signal);
  const result = z
    .object({
      version: z.literal(1),
      clonedFiles: z.number().int().nonnegative(),
    })
    .parse(
      await helper(
        ["populate", source, destination],
        destination,
        signal,
        executable,
      ),
    );

  return result.clonedFiles > 0
    ? { ...selection, clonedFiles: result.clonedFiles }
    : { backend: "git", fallbackReason: "no-reusable-files", clonedFiles: 0 };
}

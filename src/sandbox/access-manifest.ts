/**
 * 构建 Windows Sandbox provision 使用的不可变 AccessManifest，并在进入原生 supervisor 前固定对象身份。
 * SandboxBroker 在任何 ACL 或 Runtime 副作用之前调用本模块；supervisor-protocol 只接收这里生成并校验过的清单。
 *
 * 1. canonicalRoot 打开并规范化现存普通文件或目录，拒绝符号链接、junction 等重解析入口。
 * 2. objectIdentityDigest 使用规范路径、设备与文件标识生成不可逆摘要；原始路径只存在于内存控制消息，不进入日志/trace。
 * 3. buildAccessManifest 合并工作区、显式读写根和 Git 配置文件，按对象身份去重并拒绝读写模式冲突。
 * 4. manifestDigest 覆盖稳定排序后的完整清单，供账本、supervisor 响应和恢复对账使用。
 *
 * 本模块不修改 DACL，也不声称 Node 的 stat 标识可以替代 Windows 的持久 FILE_ID_128 handle。
 * 原生 supervisor 必须在授权前重新打开对象、取得卷/文件 ID 并核对摘要；不一致时安全拒绝。
 */

import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  accessManifestSchema,
  type AccessManifest,
} from "./supervisor-protocol.js";

export interface AccessManifestInput {
  workspaceRoot: string;
  readOnlyRoots?: string[];
  readWriteRoots?: string[];
  gitConfigFiles?: string[];
}

export class AccessManifestError extends Error {
  readonly code = "SANDBOX_ACCESS_MANIFEST";

  constructor(reason: string) {
    super(`Sandbox AccessManifest 无效：${reason}`);
    this.name = "AccessManifestError";
  }
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pathKey(value: string) {
  const resolved = path.resolve(value);

  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

async function canonicalRoot(input: string, expectFile = false) {
  if (!input || input.includes("\0")) {
    throw new AccessManifestError("路径为空或包含非法字符。");
  }

  let lexicalInfo: Awaited<ReturnType<typeof lstat>>;
  let canonicalPath: string;
  let objectInfo: Awaited<ReturnType<typeof stat>>;

  try {
    lexicalInfo = await lstat(input, { bigint: true });
    canonicalPath = await realpath(input);
    objectInfo = await stat(canonicalPath, { bigint: true });
  } catch {
    throw new AccessManifestError("授权对象不存在或无法稳定打开。");
  }

  if (lexicalInfo.isSymbolicLink()) {
    throw new AccessManifestError("授权根不能是符号链接或重解析入口。");
  }

  if (expectFile ? !objectInfo.isFile() : !objectInfo.isDirectory()) {
    throw new AccessManifestError(
      expectFile ? "Git 配置对象不是普通文件。" : "授权根不是目录。",
    );
  }

  const identity = [
    pathKey(canonicalPath),
    objectInfo.dev.toString(),
    objectInfo.ino.toString(),
    objectInfo.birthtimeNs.toString(),
  ].join("\0");

  return {
    rootId: digest(`root\0${identity}`).slice(0, 32),
    path: canonicalPath,
    objectIdentityDigest: digest(`object\0${identity}`),
    deviceId: objectInfo.dev.toString(),
    fileId: objectInfo.ino.toString(),
  };
}

function stableRoots<T extends { path: string }>(roots: T[]) {
  return roots.toSorted((left, right) =>
    pathKey(left.path).localeCompare(pathKey(right.path)),
  );
}

async function uniqueRoots(paths: string[], expectFile = false) {
  const byIdentity = new Map<
    string,
    Awaited<ReturnType<typeof canonicalRoot>>
  >();

  for (const input of paths) {
    const root = await canonicalRoot(input, expectFile);
    byIdentity.set(root.objectIdentityDigest, root);
  }

  return stableRoots([...byIdentity.values()]);
}

/** 构建无副作用的清单；任何失败都发生在账户 ACL、代理 lease 或 Runtime 创建之前。 */
export async function buildAccessManifest(
  input: AccessManifestInput,
): Promise<AccessManifest> {
  const workspace = await canonicalRoot(input.workspaceRoot);
  const writeRoots = await uniqueRoots([
    input.workspaceRoot,
    ...(input.readWriteRoots ?? []),
  ]);
  const readRoots = await uniqueRoots(input.readOnlyRoots ?? []);
  const gitConfigFiles = await uniqueRoots(input.gitConfigFiles ?? [], true);
  const writeIdentities = new Set(
    writeRoots.map((root) => root.objectIdentityDigest),
  );

  if (
    readRoots.some((root) => writeIdentities.has(root.objectIdentityDigest)) ||
    gitConfigFiles.some((root) =>
      writeIdentities.has(root.objectIdentityDigest),
    )
  ) {
    throw new AccessManifestError("同一对象不能同时声明为只读和可写。 ");
  }

  const payload = {
    workspaceRootId: workspace.rootId,
    readRoots,
    writeRoots,
    gitConfigFiles,
  };
  const manifestDigest = digest(JSON.stringify(payload));

  return accessManifestSchema.parse({ manifestDigest, ...payload });
}

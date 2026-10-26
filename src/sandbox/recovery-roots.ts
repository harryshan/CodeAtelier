/**
 * Windows 启动恢复时读取原生 v2 grant 的根目录提示，供已知虚拟卷临时挂载。
 * 1. readRecoveryRoots 仅接受受保护安装目录下有界普通单链接 journal，严格解码完整帧和文件名摘要。
 * 2. 返回路径不构成授权或撤销证明：Local 服务只识别自己的持久清单，最终撤销仍由 Supervisor 核对设备/文件身份。
 * 3. withRecoveryRoots 回调在账户排空后、原生撤销期间持有必要挂载；调用方负责关闭，不删除 journal 或放宽失败。
 * 不读取工作树内容、不记录路径；读取异常传递给现有 Sandbox 恢复失败边界。
 */
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export type WithRecoveryRoots = (
  roots: readonly string[],
  signal: AbortSignal,
  revoke: () => Promise<void>,
) => Promise<void>;

export async function readRecoveryRoots(installationDirectory: string) {
  const directory = path.join(installationDirectory, "grants");
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
  if (!info) {
    return [];
  }

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Invalid recovery grant directory");
  }

  const names = await readdir(directory);
  if (names.length > 1024) {
    throw new Error("Recovery grant limit exceeded");
  }

  const roots: string[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.grant$/.test(name)) {
      throw new Error("Invalid recovery grant name");
    }

    const file = path.join(directory, name);
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 262176
    ) {
      throw new Error("Invalid recovery grant file");
    }

    const handle = await open(file, "r");
    let frame: Buffer;
    try {
      const current = await handle.stat();
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size
      ) {
        throw new Error("Recovery grant identity changed");
      }

      frame = Buffer.alloc(before.size);
      const result = await handle.read(frame, 0, frame.length, 0);
      if (result.bytesRead !== frame.length) {
        throw new Error("Incomplete recovery grant");
      }
    } finally {
      await handle.close();
    }

    let offset = 0;
    const integer = () => {
      if (offset + 4 > frame.length) {
        throw new Error("Truncated recovery grant");
      }

      const value = frame.readUInt32LE(offset);
      offset += 4;

      return value;
    };

    const string = () => {
      const size = integer();
      if (!size || size > 65536 || offset + size > frame.length) {
        throw new Error("Invalid recovery grant string");
      }

      const value = new TextDecoder("utf-8", { fatal: true }).decode(
        frame.subarray(offset, offset + size),
      );
      offset += size;
      if (value.includes("\0")) {
        throw new Error("Invalid recovery grant string");
      }

      return value;
    };

    if (
      integer() !== 0x42534143 ||
      integer() !== 2 ||
      integer() !== 1 ||
      integer() > 7
    ) {
      throw new Error("Invalid recovery grant header");
    }

    const root = string();
    const device = string();
    const fileId = string();
    const digest = string();
    if (
      offset !== frame.length ||
      `${digest}.grant` !== name ||
      !/^\d+$/.test(device) ||
      !/^\d+$/.test(fileId) ||
      !path.win32.isAbsolute(root)
    ) {
      throw new Error("Invalid recovery grant identity");
    }

    roots.push(root);
  }

  return roots;
}

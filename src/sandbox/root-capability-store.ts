/**
 * Windows Broker 的持久授权根身份仓库；由 NativeWindowsSandboxRuntime 在原生启动前调用。
 * 输入是当前 AccessManifest 中已核对的真实对象身份，输出仅为本次可写根的 digest -> SID 映射。
 * 1. resolveRootCapabilities 排除实例 HOME/TEMP，并拒绝可写根覆盖 Broker 数据目录。
 * 2. readRecord 校验私有权限、版本、对象摘要和 SID；损坏记录失败关闭，绝不静默换身份。
 * 3. loadOrCreate 用系统随机数生成 SID，先写入并 flush 私有暂存文件，再用独占硬链接发布。
 *    同根并发创建只有一份记录获胜；其它调用读取胜者，不覆盖已发布的记录。
 * 4. 重启只读取现有记录。崩溃遗留暂存链接不影响已发布身份；不自动删除注册记录或修改工作区 ACL。
 * SID 不是密钥，但映射完整性影响授权，因此沿用 settings 私有文件 ACL；目录由可信宿主管理。
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  verifyPrivateSettings,
  writePrivateSettings,
} from "../config/private-settings-file.js";
import type { SandboxNativeAccess } from "./types.js";

type RootIdentity = SandboxNativeAccess["manifest"]["writeRoots"][number];

const recordSchema = z
  .object({
    version: z.literal(1),
    objectIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().min(1),
    deviceId: z.string().regex(/^[0-9]+$/),
    fileId: z.string().regex(/^[0-9]+$/),
    sid: z.string().refine(validRootCapabilitySid),
  })
  .strict();

export function validRootCapabilitySid(value: string) {
  if (!/^S-1-5-21-(?:[1-9][0-9]*-){3}[1-9][0-9]*$/.test(value)) {
    return false;
  }

  return value
    .split("-")
    .slice(4)
    .every((part) => Number(part) <= 0xffff_ffff);
}

function readRecord(file: string, root: RootIdentity): string | undefined {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
    throw new Error("授权根 capability 记录不是有效普通文件。");
  }

  verifyPrivateSettings(file);
  const record = recordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    record.objectIdentityDigest !== root.objectIdentityDigest ||
    path.relative(record.path, root.path) !== "" ||
    record.deviceId !== root.deviceId ||
    record.fileId !== root.fileId
  ) {
    throw new Error("授权根 capability 记录身份不匹配。");
  }

  return record.sid;
}

function loadOrCreate(directory: string, root: RootIdentity) {
  const digest = root.objectIdentityDigest;
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("授权根对象摘要无效。");
  }

  const file = path.join(directory, `${digest}.json`);
  const existing = readRecord(file, root);
  if (existing) {
    return existing;
  }

  const words = Array.from({ length: 4 }, () => {
    let value = 0;
    while (value === 0) {
      value = randomBytes(4).readUInt32LE();
    }

    return value;
  });
  const record = {
    version: 1,
    objectIdentityDigest: digest,
    path: root.path,
    deviceId: root.deviceId,
    fileId: root.fileId,
    sid: `S-1-5-21-${words.join("-")}`,
  };
  const staging = path.join(directory, `${digest}.${randomUUID()}.pending`);
  try {
    writePrivateSettings(staging, JSON.stringify(record));
    try {
      // link 不覆盖目标，且目标从出现起就是完整、已设私有 ACL 的同一文件对象。
      linkSync(staging, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const published = readRecord(file, root);
    if (!published) {
      throw new Error("授权根 capability 记录发布结果未知。");
    }

    return published;
  } finally {
    try {
      unlinkSync(staging);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function within(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function resolveRootCapabilities(
  dataDirectory: string,
  access: SandboxNativeAccess,
  signal: AbortSignal,
): Map<string, string> {
  signal.throwIfAborted();
  mkdirSync(dataDirectory, { recursive: true });
  const canonicalData = realpathSync(dataDirectory);
  const directory = path.join(canonicalData, "sandbox-root-capabilities");
  for (const root of access.manifest.writeRoots) {
    if (within(root.path, canonicalData) || within(directory, root.path)) {
      throw new Error("可写授权根不能覆盖 Broker capability 数据目录。");
    }
  }

  mkdirSync(directory, { recursive: true });
  if (
    lstatSync(directory).isSymbolicLink() ||
    !lstatSync(directory).isDirectory()
  ) {
    throw new Error("capability 数据目录不能是链接或非目录。");
  }

  const result = new Map<string, string>();
  for (const root of access.manifest.writeRoots) {
    signal.throwIfAborted();
    if (
      access.privateDirectory &&
      path.relative(root.path, access.privateDirectory) === ""
    ) {
      continue;
    }

    const sid = loadOrCreate(directory, root);
    if ([...result.values()].includes(sid)) {
      throw new Error("不同授权根不能共用同一 capability SID。");
    }

    result.set(root.objectIdentityDigest, sid);
  }

  return result;
}

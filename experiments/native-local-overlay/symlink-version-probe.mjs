/**
 * Linux 内部链接版本的手动发布回归；在构建后用 Linux Node 运行，不启动服务或安装依赖。
 * 1. 在独占 ext4 夹具建立普通源码、目标文件和内部链接，导入实际构建的 Publisher/读版本模块。
 * 2. 证明目标正文变化与链接身份变化分别失效；普通源码可发布，链接路径不能作为源码编辑。
 * 3. 改向后旧凭据必须阻止发布，来源保留上次成功内容；绝对/外部及父路径链接拒绝。
 * 报告只含断言状态，夹具保留供诊断；挂载/Runtime 由 startup-probe --symlinks 独立验证。
 */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  unlink,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceIdentity } from "../../dist/server/local-overlays/publication/files.js";
import { readVersion } from "../../dist/server/local-overlays/publication/read-version.js";
import { EditSession } from "../../dist/server/local-overlays/publication/session.js";
import { Publisher } from "../../dist/server/local-overlays/publication/publisher.js";

assert.equal(process.platform, "linux");
const parent = path.join(os.homedir(), "codeatelier-native-overlay-probes");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "link-version-"));
const directory = path.join(root, "source");
await mkdir(directory);
await writeFile(path.join(directory, "dep"), "one");
await writeFile(path.join(directory, "other"), "two");
await writeFile(path.join(directory, "code"), "original\n");
await symlink("dep", path.join(directory, "alias"));
const source = await sourceIdentity(directory);
const read = { path: "alias", kind: "symlink" };
const version = await readVersion(source, read);
const targetVersion = await readVersion(source, { path: "dep" });
await writeFile(path.join(directory, "dep"), "changed");
assert.equal(await readVersion(source, read), version);
assert.notEqual(await readVersion(source, { path: "dep" }), targetVersion);

const session = new EditSession(source);
await session.read("code");
await session.edit("code", Buffer.from("private\n"));
await assert.rejects(session.read("alias"), /PATH_REPLACED/);
const batch = session.seal();
batch.reads.push({ ...read, version });
const publisher = new Publisher(path.join(root, "publications"));
await publisher.publish(batch, { validate: async () => {} });
assert.equal(await readFile(path.join(directory, "code"), "utf8"), "private\n");

const next = new EditSession(source);
await next.read("code");
await next.edit("code", Buffer.from("later\n"));
const pending = next.seal();
pending.reads.push({ ...read, version });
await unlink(path.join(directory, "alias"));
await symlink("other", path.join(directory, "alias"));
assert.notEqual(await readVersion(source, read), version);
await assert.rejects(
  publisher.publish(pending, { validate: async () => {} }),
  /STALE_DEPENDENCY/,
);
assert.equal(await readFile(path.join(directory, "code"), "utf8"), "private\n");

await symlink("../outside", path.join(directory, "external"));
await assert.rejects(
  readVersion(source, { path: "external", kind: "symlink" }),
  /SYMLINK_TARGET_REJECTED/,
);
await symlink(directory, path.join(directory, "absolute"));
await assert.rejects(
  readVersion(source, { path: "absolute", kind: "symlink" }),
  /SYMLINK_TARGET_REJECTED/,
);
await symlink(".", path.join(directory, "parent"));
await assert.rejects(
  readVersion(source, { path: "parent/alias", kind: "symlink" }),
  /PATH_REPLACED/,
);

const report = {
  passed: true,
  targetVersionIndependent: true,
  ordinarySourcePublished: true,
  staleLinkRejected: true,
  sourceUnchangedOnRejection: true,
  externalAndAliasWritesRejected: true,
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(JSON.stringify({ root, ...report }) + "\n");

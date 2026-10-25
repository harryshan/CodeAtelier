/**
 * Windows 原生发布与权限保留手动验证，只操作 .local 中本脚本创建的普通文件。
 * 1. 为夹具设置保护 DACL、显式拒绝 ACE 和不同 primary group，比较完整 owner/group/DACL。
 * 2. 检查正文、已有命名流、备份原文；错误身份/内容不得清理备份，正确确认才按句柄删除。
 * 3. 陈旧输入、硬链接和 junction 目标必须在替换前拒绝，不能回退普通 rename。
 * 4. 真实 Publisher 验证成功后备份清理、写后故障保留备份/unknown 日志和禁止再次发布。
 * 不安装驱动、不改真实项目 ACL、不提升用户权限、不运行模型或 Evaluation；输出有界事实报告。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  link,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import {
  digest,
  sourceIdentity,
} from "../src/local-overlays/publication/files.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import {
  windowsReplace,
  windowsCleanup,
} from "./local-overlay/windows-publish.js";

assert.equal(process.platform, "win32");
const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-publish-"));
const source = path.join(root, "source");
await mkdir(source);
const target = path.join(source, "file.txt");
const temporary = path.join(source, ".codeatelier-publish-direct.tmp");
const original = Buffer.from("original\n");
const candidate = Buffer.from("candidate\n");
await writeFile(target, original);
await writeFile(temporary, candidate);
await writeFile(target + ":retained", "existing stream");

async function security(file: string, configure = false, denyWrite = false) {
  const result = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $ErrorActionPreference = 'Stop'
    $file = $env:CODEATELIER_PUBLISH_FIXTURE
    $acl = [System.IO.File]::GetAccessControl($file)
    if ($env:CODEATELIER_PUBLISH_CONFIGURE -eq '1') {
      $acl.SetAccessRuleProtection($true, $true)
      $guests = [System.Security.Principal.SecurityIdentifier]'S-1-5-32-546'
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($guests, 'Write', 'Deny')
      $acl.AddAccessRule($rule)
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $ownerRule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow')
      $acl.AddAccessRule($ownerRule)
      [System.IO.File]::SetAccessControl($file, $acl)
      $acl = [System.IO.File]::GetAccessControl($file)
      $acl.SetGroup([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545')
      [System.IO.File]::SetAccessControl($file, $acl)
    }
    if ($env:CODEATELIER_PUBLISH_DENY_WRITE -eq '1') {
      $acl = [System.IO.File]::GetAccessControl($file)
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'Write', 'Deny')
      $acl.AddAccessRule($rule)
      [System.IO.File]::SetAccessControl($file, $acl)
    }
    $sections = [System.Security.AccessControl.AccessControlSections]'Owner,Group,Access'
    [System.IO.File]::GetAccessControl($file).GetSecurityDescriptorSddlForm($sections)
  `,
    ],
    {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        CODEATELIER_PUBLISH_FIXTURE: file,
        CODEATELIER_PUBLISH_CONFIGURE: configure ? "1" : "0",
        CODEATELIER_PUBLISH_DENY_WRITE: denyWrite ? "1" : "0",
      },
    },
  );

  return result.stdout.trim();
}

const beforeSecurity = await security(target, true);
assert.notEqual(beforeSecurity, await security(temporary));
const backupIdentity = await windowsReplace(
  target,
  temporary,
  digest(original),
  digest(candidate),
);
const backup = temporary + ".backup";
assert.deepEqual(await readFile(target), candidate);
assert.equal(await security(target), beforeSecurity);
assert.equal(await readFile(target + ":retained", "utf8"), "existing stream");
assert.deepEqual(await readFile(backup), original);
assert.equal(await security(backup), beforeSecurity);
await assert.rejects(windowsCleanup(backup, "0:0", digest(original)));
assert.deepEqual(await readFile(backup), original);
await writeFile(backup, "changed backup\n");
await assert.rejects(windowsCleanup(backup, backupIdentity, digest(original)));
assert.equal(await readFile(backup, "utf8"), "changed backup\n");
await writeFile(backup, original);
await windowsCleanup(backup, backupIdentity, digest(original));
await assert.rejects(readFile(backup), { code: "ENOENT" });

await writeFile(temporary, original);
await assert.rejects(
  windowsReplace(target, temporary, digest(original), digest(original)),
);
assert.deepEqual(await readFile(target), candidate);
await link(target, path.join(source, "linked.txt"));
await assert.rejects(
  windowsReplace(target, temporary, digest(candidate), digest(original)),
);
assert.deepEqual(await readFile(target), candidate);
const alias = path.join(root, "alias");
await symlink(source, alias, "junction");
await writeFile(path.join(source, "junction-target.txt"), original);
await writeFile(
  path.join(source, ".codeatelier-publish-junction.tmp"),
  candidate,
);
await assert.rejects(
  windowsReplace(
    path.join(alias, "junction-target.txt"),
    path.join(alias, ".codeatelier-publish-junction.tmp"),
    digest(original),
    digest(candidate),
  ),
);
assert.deepEqual(
  await readFile(path.join(source, "junction-target.txt")),
  original,
);

const denied = path.join(source, "denied.txt");
const deniedCandidate = path.join(source, ".codeatelier-publish-denied.tmp");
await writeFile(denied, original);
await writeFile(deniedCandidate, candidate);
await security(denied, false, true);
await assert.rejects(
  windowsReplace(denied, deniedCandidate, digest(original), digest(candidate)),
);
assert.deepEqual(
  await readFile(denied),
  original,
  "A source write denial must prevent replacement itself",
);

const sourceInfo = await sourceIdentity(source);
const publisher = new Publisher(
  path.join(root, "publisher"),
  createLogger(root, "info"),
);
async function batch(name: string) {
  await writeFile(path.join(source, name), original);
  const session = new EditSession(sourceInfo);
  await session.read(name);
  await session.edit(name, candidate);

  return session.seal();
}

const success = await batch("success.txt");
const successSecurity = await security(path.join(source, "success.txt"), true);
const result = await publisher.publish(success, {
  nativeWindows: true,
  validate: async () => {},
});
assert.equal(result.cleanupPending, 0);
assert.equal(await security(path.join(source, "success.txt")), successSecurity);
assert.equal(
  (await readdir(source)).some((name) => name.includes(success.id)),
  false,
);

const cleanupConflict = await batch("cleanup-pending.txt");
let changedBackup: string | undefined;
const pendingResult = await publisher.publish(cleanupConflict, {
  nativeWindows: true,
  validate: async () => {},
  afterWrite: async () => {
    const name = (await readdir(source)).find(
      (item) => item.includes(cleanupConflict.id) && item.endsWith(".backup"),
    );
    assert.ok(name);
    changedBackup = path.join(source, name);
    await writeFile(changedBackup, "external backup edit\n");
  },
});
assert.equal(pendingResult.cleanupPending, 1);
assert.equal((await publisher.inspect(cleanupConflict)).state, "complete");
assert.equal(await readFile(changedBackup!, "utf8"), "external backup edit\n");
assert.deepEqual(
  await readFile(path.join(source, "cleanup-pending.txt")),
  candidate,
);

const interrupted = await batch("unknown.txt");
await assert.rejects(
  publisher.publish(interrupted, {
    nativeWindows: true,
    validate: async () => {},
    afterWrite: async () => {
      throw new Error("Injected receipt interruption");
    },
  }),
);
const observation = await publisher.inspect(interrupted);
assert.equal(observation.state, "unknown");
assert.equal(observation.files[0]?.observed, "matches_after");
const retained = (await readdir(source)).find(
  (name) => name.includes(interrupted.id) && name.endsWith(".backup"),
);
assert.ok(retained);
assert.deepEqual(await readFile(path.join(source, retained)), original);
await assert.rejects(
  publisher.publish(interrupted, {
    nativeWindows: true,
    lockTimeoutMs: 30,
    validate: async () => {},
  }),
);

const reportFile = path.join(root, "report.json");
await writeFile(
  reportFile,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      release: os.release(),
      ownerGroupDacl:
        "matched; protected DACL, explicit deny ACE and non-default primary group",
      originalNamedStream: "retained",
      cleanup:
        "wrong identity and changed content refused; matching backup removed",
      staleHashHardlinkAndJunction: "rejected",
      sourceWriteDenied: "replacement refused before source mutation",
      publisherSuccess:
        "content and security verified; backup removed after complete journal",
      cleanupConflict:
        "changed backup retained; publication remains complete with cleanupPending=1",
      publisherUnknown:
        "after-write fault retained backup and lock; replay refused",
      limitations: [
        "No SACL, integrity-label or arbitrary foreign-owner privilege guarantee",
        "No foreign-owner privilege guarantee; differing group uses the exact source DACL's WRITE_OWNER right",
        "Not an external-writer compare-and-swap or multi-file atomic commit",
        "Synthetic NTFS host fixtures; not product UI or Sandbox publication lifecycle",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `LOCAL_OVERLAY_NATIVE_PUBLISH PASS report=${reportFile}\n`,
);

/**
 * 手动验证产品 WorktreeService 的原生 CoW 接入；不调用模型、真实项目或 Evaluation。
 * 1. 参数是已存在实验卷上的父目录、已构建 helper，以及可选预期 backend/objectFormat；mkdtemp 创建唯一 fixture，不格式化或挂载。
 * 2. run 验证来源直接复用、选定 commit/脏状态/attributes、独立 index、重启绑定和 Git fallback。
 * 3. 真实失败/取消 helper 验证失败现场保留和禁止重放；输出路径及计数供外部 fiemap/重挂载核对。
 * fixture 保留，不自动删除。调用者负责显式管理实验卷生命周期。
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { WorktreeService } from "../src/worktrees/service.js";
import { git } from "../src/worktrees/git.js";
import type { Session } from "../src/shared/types.js";

const parent = process.argv[2];
const helper = process.argv[3];
const expectedBackend = process.argv[4] ?? "riftri-reflink";
const objectFormat = process.argv[5] ?? "sha1";
if (!parent || !helper || process.platform !== "linux") {
  throw new Error(
    "Usage: verify-riftri <existing Linux test parent> <absolute helper>",
  );
}

const root = await mkdtemp(path.join(parent, "codeatelier-native-"));
const source = path.join(root, "source repository");
const directory = path.join(root, "private");
await mkdir(source);
await mkdir(directory);
const log = pino({ enabled: false });
const service = new WorktreeService(directory, log, helper);
const sessions: Session[] = [];
const bind = async (workspace: string) => {
  let session = sessions.find((item) => item.workspace === workspace);
  if (!session) {
    session = {
      id: randomUUID(),
      workspace,
      title: "native test",
      titleState: "pending",
      createdAt: "now",
      updatedAt: "now",
    };
    sessions.push(session);
  }

  return session;
};

const create = (baseRef = "HEAD", manager = service) =>
  manager.create({ id: randomUUID(), workspace: source, baseRef }, bind);

async function run() {
  await git(source, ["init", "-b", "main", `--object-format=${objectFormat}`]);
  await git(source, ["config", "user.name", "Native fixture"]);
  await git(source, ["config", "user.email", "native@example.invalid"]);
  await git(source, ["config", "core.autocrlf", "false"]);
  await writeFile(
    path.join(source, "large.bin"),
    randomBytes(32 * 1024 * 1024),
  );
  await writeFile(path.join(source, "tracked.txt"), "committed\n");
  await writeFile(path.join(source, "staged.txt"), "original stage\n");
  await writeFile(path.join(source, "mode.sh"), "echo ok\n");
  await chmod(path.join(source, "mode.sh"), 0o755);
  await symlink("tracked.txt", path.join(source, "link"));
  await writeFile(path.join(source, ".gitignore"), "ignored\n");
  await writeFile(
    path.join(source, ".gitattributes"),
    "filtered.txt filter=test\ncrlf.txt text eol=crlf\n",
  );
  await writeFile(path.join(source, "filtered.txt"), "plain\n");
  await writeFile(path.join(source, "crlf.txt"), "line\n");
  await writeFile(path.join(source, "空 格\n\t.txt"), "unusual filename\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const initial = await git(source, ["rev-parse", "HEAD"]);
  await git(source, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${initial},submodule`,
  ]);
  await git(source, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "gitlink fixture",
  ]);
  const commit = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["config", "filter.test.smudge", "sed s/plain/smudged/"]);
  await git(source, ["config", "filter.test.clean", "sed s/smudged/plain/"]);
  await writeFile(path.join(source, "tracked.txt"), "dirty\n");
  await writeFile(path.join(source, "staged.txt"), "staged\n");
  await git(source, ["add", "staged.txt"]);
  await chmod(path.join(source, "mode.sh"), 0o600);
  await writeFile(path.join(source, "ignored"), "ignored");
  await writeFile(path.join(source, "untracked"), "private");
  const before = await git(source, ["status", "--porcelain"]);
  const permission = (await stat(path.join(source, "mode.sh"))).mode;
  const first = await create();
  const second = await create(commit);
  assert.equal(first.worktree?.backend, expectedBackend);
  assert.equal(second.worktree?.backend, expectedBackend);
  for (const session of [first, second]) {
    assert.equal(
      await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
      "committed\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "staged.txt"), "utf8"),
      "original stage\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "filtered.txt"), "utf8"),
      "smudged\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "crlf.txt"), "utf8"),
      "line\r\n",
    );
    assert.equal(
      (await stat(path.join(session.workspace, "mode.sh"))).mode & 0o111,
      0o111,
    );
    assert.equal(
      (await lstat(path.join(session.workspace, "link"))).isSymbolicLink(),
      true,
    );
    assert.equal(
      (await readdir(session.workspace)).includes("untracked"),
      false,
    );
    assert.equal((await readdir(session.workspace)).includes("ignored"), false);
    assert.equal(await git(session.workspace, ["rev-parse", "HEAD"]), commit);
    assert.equal(
      await git(session.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "HEAD",
    );
    assert.equal(await git(session.workspace, ["status", "--porcelain"]), "");
    assert.equal(
      await readFile(path.join(session.workspace, "空 格\n\t.txt"), "utf8"),
      "unusual filename\n",
    );
    assert.equal(
      (await stat(path.join(session.workspace, "submodule"))).isDirectory(),
      true,
    );
    assert.deepEqual(await service.gitWriteRoots(session.workspace), [
      path.join(source, ".git"),
    ]);
    assert.equal(await service.projectWorkspace(session.workspace), source);
  }

  assert.notEqual(
    (await stat(path.join(first.workspace, "large.bin"))).ino,
    (await stat(path.join(source, "large.bin"))).ino,
  );
  assert.equal(await git(source, ["status", "--porcelain"]), before);
  assert.equal((await stat(path.join(source, "mode.sh"))).mode, permission);
  assert.equal(
    (await readdir(path.join(source, ".git"))).includes("riftri"),
    false,
  );
  await Promise.all([
    writeFile(path.join(first.workspace, "tracked.txt"), "first edit\n"),
    writeFile(path.join(second.workspace, "tracked.txt"), "second edit\n"),
  ]);
  await git(first.workspace, ["add", "tracked.txt"]);
  assert.equal(
    await git(second.workspace, ["diff", "--cached", "--name-only"]),
    "",
  );
  assert.equal(
    await readFile(path.join(source, "tracked.txt"), "utf8"),
    "dirty\n",
  );
  await writeFile(path.join(source, "new-version.txt"), "new commit only\n");
  await git(source, ["add", "tracked.txt", "new-version.txt"]);
  await git(source, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "new source version",
  ]);
  const older = await create(commit);
  assert.equal(
    await readFile(path.join(older.workspace, "tracked.txt"), "utf8"),
    "committed\n",
  );
  assert.equal(
    (await readdir(older.workspace)).includes("new-version.txt"),
    false,
  );
  assert.equal(await git(older.workspace, ["status", "--porcelain"]), "");
  const duplicate = await service.create(
    { id: first.worktree!.id, workspace: source, baseRef: "HEAD" },
    bind,
  );
  assert.equal(duplicate.id, first.id);
  assert.equal(
    await readFile(path.join(first.workspace, "tracked.txt"), "utf8"),
    "first edit\n",
  );
  // Git accepts non-UTF8 paths on Linux. The native helper must decline safely before cloning.
  const bytePath = Buffer.concat([
    Buffer.from(source + path.sep),
    Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]),
  ]);
  await writeFile(bytePath, "byte filename\n");
  await git(source, ["add", "--all"]);
  await git(source, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "byte path",
  ]);
  const byteCheckout = await create();
  assert.equal(byteCheckout.worktree?.backend, "git");
  assert.equal(
    await git(byteCheckout.workspace, ["status", "--porcelain"]),
    "",
  );
  await service.close();
  // Losing the helper after creation must not invalidate an ordinary linked worktree.
  const restarted = new WorktreeService(
    directory,
    log,
    path.join(root, "missing-helper"),
  );
  try {
    await restarted.validate(first.workspace);
    assert.equal(
      (await restarted.describe(first)).worktree?.backend,
      expectedBackend,
    );
    const fallback = await create(commit, restarted);
    assert.equal(fallback.worktree?.backend, "git");
    assert.equal(fallback.worktree?.fallbackReason, "helper-unavailable");
  } finally {
    await restarted.close();
  }

  const failedHelper = path.join(root, "failed-helper");
  await writeFile(
    failedHelper,
    '#!/bin/sh\nif [ "$1" = probe ]; then printf \'{"version":1,"backend":"riftri-reflink"}\\n\'; else touch "$3/partial"; exit 1; fi\n',
    { mode: 0o755 },
  );
  const failing = new WorktreeService(directory, log, failedHelper);
  const failedRequest = {
    id: randomUUID(),
    workspace: source,
    baseRef: commit,
  };
  try {
    await assert.rejects(failing.create(failedRequest, bind));
    await assert.rejects(failing.create(failedRequest, bind), /不会回退/);
    assert.equal(
      (await readdir(path.join(failing.root, failedRequest.id))).includes(
        "partial",
      ),
      true,
    );
  } finally {
    await failing.close();
  }

  const slowHelper = path.join(root, "slow-helper");
  await writeFile(
    slowHelper,
    '#!/bin/sh\nif [ "$1" = probe ]; then printf \'{"version":1,"backend":"riftri-reflink"}\\n\'; else touch "$3/started"; exec sleep 120; fi\n',
    { mode: 0o755 },
  );
  const slow = new WorktreeService(directory, log, slowHelper);
  const cancelledRequest = {
    id: randomUUID(),
    workspace: source,
    baseRef: commit,
  };
  const pending = slow.create(cancelledRequest, bind);
  const rejected = assert.rejects(pending);
  const started = path.join(slow.root, cancelledRequest.id, "started");
  const deadline = Date.now() + 10000;
  while (!(await lstat(started).catch(() => undefined))) {
    assert.ok(Date.now() < deadline, "helper must start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  await slow.close();
  await rejected;
  const manifest = JSON.parse(
    await readFile(
      path.join(directory, "worktrees", `${cancelledRequest.id}.json`),
      "utf8",
    ),
  );
  assert.equal(manifest.state, "failed");
  const result = {
    root,
    source,
    first,
    second,
    commit,
    tests:
      "direct source, dirty/staged/ignored, filters/eol/modes/symlink, independent writes/index, restart, fallback, failure, cancellation",
  };
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(result, null, 2),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

try {
  await run();
} finally {
  await service.close();
}

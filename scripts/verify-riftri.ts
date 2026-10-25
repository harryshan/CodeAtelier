/**
 * 手动验证 D167 Riftri 当前目录快照；参数为已有 Linux 实验卷父目录和 v2 helper。
 * 1. 创建独立临时 Git fixture，含脏/暂存/删除/忽略/未跟踪内容、链接和特殊文件名。
 * 2. 两个 Riftri 副本验证文件/Git 独立性、目录身份、重启幂等与 Sandbox 根；Worktree 保持提交基线。
 * 3. 检查不支持卷/缺少 helper 和外置 Git/链接/活跃锁的拒绝；失败请求不重放。
 * 4. 输出保留目录供 fiemap/重挂载验证，不格式化、挂载、访问用户仓库、调用模型或运行 Evaluation。
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
  readlink,
  rm,
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
if (!parent || !helper || process.platform !== "linux") {
  throw new Error(
    "Usage: verify-riftri <existing Linux test parent> <absolute helper> [riftri-reflink|unsupported]",
  );
}

const root = await mkdtemp(path.join(parent, "codeatelier-snapshot-"));
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
      title: "snapshot",
      titleState: "pending",
      createdAt: "now",
      updatedAt: "now",
    };
    sessions.push(session);
  }

  return session;
};

const input = () => ({ id: randomUUID(), workspace: source });

async function run() {
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Snapshot fixture"]);
  await git(source, ["config", "user.email", "snapshot@example.invalid"]);
  await git(source, ["config", "core.autocrlf", "false"]);
  await writeFile(
    path.join(source, "large.bin"),
    randomBytes(32 * 1024 * 1024),
  );
  await writeFile(path.join(source, "tracked.txt"), "committed\n");
  await writeFile(path.join(source, "deleted.txt"), "committed\n");
  await writeFile(path.join(source, "mode.sh"), "echo test\n");
  await chmod(path.join(source, "mode.sh"), 0o755);
  await writeFile(path.join(source, ".gitignore"), "ignored\n");
  await writeFile(
    path.join(source, ".gitattributes"),
    "tracked.txt text eol=crlf\n",
  );
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const commit = await git(source, ["rev-parse", "HEAD"]);
  await writeFile(path.join(source, "tracked.txt"), "staged\n");
  await git(source, ["add", "tracked.txt"]);
  await writeFile(path.join(source, "tracked.txt"), "dirty exact bytes\n");
  await writeFile(path.join(source, "ignored"), "dependency\n");
  await writeFile(path.join(source, "untracked"), "new\n");
  await writeFile(path.join(source, "空 格\n\t.txt"), "unusual\n");
  const bytePath = Buffer.concat([
    Buffer.from(source + "/raw-"),
    Buffer.from([255]),
  ]);
  await writeFile(bytePath, "non UTF8\n");
  await rm(path.join(source, "deleted.txt"));
  await symlink("tracked.txt", path.join(source, "link"));
  await symlink(
    path.join(source, "tracked.txt"),
    path.join(source, "absolute-link"),
  );
  await mkdir(path.join(source, ".git", "worktrees", "old"), {
    recursive: true,
  });
  await writeFile(
    path.join(source, ".git", "worktrees", "old", "gitdir"),
    "/not/a/live/worktree/.git",
  );

  if (expectedBackend === "unsupported") {
    await assert.rejects(service.createRiftri(input(), bind), /Riftri 不可用/);
    const plain = await service.create({ ...input(), baseRef: "HEAD" }, bind);
    assert.equal(plain.worktree?.backend, "git");
    assert.equal(
      await git(plain.workspace, ["show", "HEAD:tracked.txt"]),
      "committed",
    );
    assert.equal(sessions.length, 1);
    process.stdout.write(
      JSON.stringify({ root, unsupported: true, plain }, null, 2),
    );

    return;
  }

  const before = await git(source, ["status", "--porcelain"]);
  const request = input();
  const first = await service.createRiftri(request, bind);
  const second = await service.createRiftri(input(), bind);
  for (const session of [first, second]) {
    assert.equal(session.worktree?.mode, "riftri");
    assert.equal(session.worktree?.backend, expectedBackend);
    assert.equal(
      await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
      "dirty exact bytes\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "ignored"), "utf8"),
      "dependency\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "untracked"), "utf8"),
      "new\n",
    );
    assert.equal(
      await readFile(
        Buffer.concat([
          Buffer.from(session.workspace + "/raw-"),
          Buffer.from([255]),
        ]),
        "utf8",
      ),
      "non UTF8\n",
    );
    assert.equal(
      await git(session.workspace, ["show", ":tracked.txt"]),
      "staged",
    );
    assert.equal(
      await git(session.workspace, ["status", "--porcelain"]),
      before,
    );
    assert.equal(
      await git(session.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "main",
    );
    assert.equal(
      (await lstat(path.join(session.workspace, "mode.sh"))).mode & 0o777,
      0o755,
    );
    assert.equal(
      await readlink(path.join(session.workspace, "absolute-link")),
      path.join(session.workspace, "tracked.txt"),
    );
    assert.equal(
      await readlink(path.join(session.workspace, "link")),
      "tracked.txt",
    );
    assert.ok(
      !(await readdir(path.join(session.workspace, ".git"))).includes(
        "worktrees",
      ),
    );
    assert.deepEqual(await service.gitWriteRoots(session.workspace), []);
    assert.equal(await service.projectWorkspace(session.workspace), source);
  }

  await writeFile(path.join(first.workspace, "tracked.txt"), "agent edit\n");
  await git(first.workspace, ["add", "tracked.txt"]);
  await git(first.workspace, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "agent",
  ]);
  assert.notEqual(await git(first.workspace, ["rev-parse", "HEAD"]), commit);
  assert.equal(await git(second.workspace, ["rev-parse", "HEAD"]), commit);
  assert.equal(await git(source, ["rev-parse", "HEAD"]), commit);
  assert.equal(await git(source, ["status", "--porcelain"]), before);
  const plain = await service.create({ ...input(), baseRef: "HEAD" }, bind);
  assert.equal(plain.worktree?.backend, "git");
  assert.equal(
    await git(plain.workspace, ["show", "HEAD:tracked.txt"]),
    "committed",
  );
  assert.ok(!(await readdir(plain.workspace)).includes("untracked"));

  for (const failure of ["git-lock", "external-link", "alternates"]) {
    const invalid =
      failure === "git-lock"
        ? path.join(source, ".git", "index.lock")
        : failure === "alternates"
          ? path.join(source, ".git", "objects", "info", "alternates")
          : path.join(source, "external-link");
    if (failure === "external-link") {
      await symlink("/etc", invalid);
    } else {
      await writeFile(invalid, "fixture");
    }

    const failedRequest = input();
    await assert.rejects(service.createRiftri(failedRequest, bind));
    await rm(invalid);
    await assert.rejects(service.createRiftri(failedRequest, bind), /不会回退/);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(directory, "worktrees", failedRequest.id + ".json"),
          "utf8",
        ),
      ).state,
      "failed",
    );
  }

  await service.close();
  const restarted = new WorktreeService(
    directory,
    log,
    path.join(root, "missing-helper"),
  );
  try {
    assert.equal((await restarted.createRiftri(request, bind)).id, first.id);
    assert.equal(
      await readFile(path.join(first.workspace, "tracked.txt"), "utf8"),
      "agent edit\n",
    );
    await assert.rejects(
      restarted.createRiftri(input(), bind),
      /显式选择 Git worktree/,
    );
  } finally {
    await restarted.close();
  }

  process.stdout.write(
    JSON.stringify(
      {
        root,
        source,
        directory,
        first,
        second,
        plain,
        request,
        checks:
          "dirty/staged/deleted/untracked/ignored/byte-paths/links/independent-refs/restart/failure-retention",
      },
      null,
      2,
    ),
  );
}

try {
  await run();
} finally {
  await service.close();
}

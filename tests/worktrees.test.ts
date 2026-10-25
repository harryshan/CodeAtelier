/**
 * 用临时真实 Git 仓库验证 Worktree 生命周期与系统联动，不访问用户仓库或模型。
 * 1. fixture 在同一个测试根下放置来源、私有数据和 checkout，并登记服务关闭后再清理。
 * 2. 创建测试检查基线、独立文件/index、请求去重、重启与未知状态；替换和 gitfile 篡改必须拒绝。
 * 3. HTTP/Engine 测试检查项目分组元数据、调度、恢复和失效路径；记忆映射保留工具的实际工作区。
 * 4. 所有 Git 参数固定，清理仅针对 fixture 自己创建的临时根。
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  open,
  symlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { WorktreeService } from "../src/worktrees/service.js";
import { git } from "../src/worktrees/git.js";
import type { Session } from "../src/shared/types.js";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { ProjectMemoryService } from "../src/memory/service.js";
import { temp } from "./fixtures/helpers.js";
import { currentTestResources } from "./fixtures/test-resources.js";

const log = pino({ enabled: false });

async function fixture() {
  const root = await temp();
  const source = path.join(root, "source repository");
  const directory = path.join(root, "private");
  await mkdir(source);
  await mkdir(directory);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Worktree Test"]);
  await git(source, ["config", "user.email", "worktree@example.invalid"]);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(source, "AGENTS.md"), "WORKTREE_BASE_RULE\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  const service = new WorktreeService(directory, log);
  currentTestResources().defer(() => service.close());
  const sessions: Session[] = [];
  const bind = async (workspace: string) => {
    let session = sessions.find((item) => item.workspace === workspace);
    if (!session) {
      session = {
        id: randomUUID(),
        workspace,
        title: "test",
        titleState: "pending",
        createdAt: "now",
        updatedAt: "now",
      };
      sessions.push(session);
    }

    return session;
  };

  const input = { id: randomUUID(), workspace: source, baseRef: "HEAD" };

  return { root, source, directory, service, bind, input, sessions };
}

it("creates detached worktrees at committed bases without copying dirty or ignored files", async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, "tracked.txt"), "local dirty\n");
  await writeFile(path.join(f.source, "ignored.txt"), "private");
  await writeFile(path.join(f.source, "untracked.txt"), "local");
  const session = await f.service.create(f.input, f.bind);
  expect(
    await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
  ).toBe("base\n");
  expect(await readdir(session.workspace)).not.toContain("ignored.txt");
  expect(await readdir(session.workspace)).not.toContain("untracked.txt");
  expect(
    await git(session.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ).toBe("HEAD");
  await writeFile(path.join(session.workspace, "tracked.txt"), "agent edit\n");
  await git(session.workspace, ["add", "tracked.txt"]);
  expect(await readFile(path.join(f.source, "tracked.txt"), "utf8")).toBe(
    "local dirty\n",
  );
  expect(await git(f.source, ["diff", "--cached", "--name-only"])).toBe("");
  expect(await f.service.gitWriteRoots(session.workspace)).toEqual([
    path.join(f.source, ".git"),
  ]);
  expect(session.worktree?.projectWorkspace).toBe(f.source);
});

it("deduplicates concurrent requests and rebinds after a service restart without resetting edits", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([
    f.service.create(f.input, f.bind),
    f.service.create(f.input, f.bind),
  ]);
  expect(first.id).toBe(second.id);
  await writeFile(path.join(first.workspace, "tracked.txt"), "keep me");
  await f.service.close();
  const restarted = new WorktreeService(f.directory, log);
  currentTestResources().defer(() => restarted.close());
  const restored = await restarted.create(f.input, f.bind);
  expect(restored.id).toBe(first.id);
  expect(
    await readFile(path.join(first.workspace, "tracked.txt"), "utf8"),
  ).toBe("keep me");
  expect(f.sessions).toHaveLength(1);
  await expect(
    restarted.create({ ...f.input, baseRef: "main" }, f.bind),
  ).rejects.toThrow("不能改变");
});

it("retains a successful checkout when session persistence fails and binds it on retry", async () => {
  const f = await fixture();
  await expect(
    f.service.create(f.input, async () => {
      throw new Error("store unavailable");
    }),
  ).rejects.toThrow("store unavailable");
  const workspace = path.join(f.service.root, f.input.id);
  await writeFile(path.join(workspace, "tracked.txt"), "preserved");
  const session = await f.service.create(f.input, f.bind);
  expect(session.workspace).toBe(workspace);
  expect(await readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe(
    "preserved",
  );
});

it("rejects missing or replaced directories while keeping history readable", async () => {
  const f = await fixture();
  const session = await f.service.create(f.input, f.bind);
  await rename(session.workspace, session.workspace + "-moved");
  await expect(f.service.validate(session.workspace)).rejects.toThrow(
    "不会回退",
  );
  expect((await f.service.describe(session)).id).toBe(session.id);
  await mkdir(session.workspace);
  await expect(f.service.validate(session.workspace)).rejects.toThrow("身份");
});

it("rejects changed Git pointers and missing manifests without treating them as Local", async () => {
  const f = await fixture();
  const session = await f.service.create(f.input, f.bind);
  // Git for Windows marks .git hidden; r+ can replace its contents without changing that attribute.
  const pointer = await open(path.join(session.workspace, ".git"), "r+");
  try {
    await pointer.truncate();
    await pointer.writeFile(`gitdir: ${path.join(f.source, ".git")}\n`);
  } finally {
    await pointer.close();
  }

  await expect(f.service.gitWriteRoots(session.workspace)).rejects.toThrow(
    "不可用",
  );
  await rename(
    path.join(f.directory, "worktrees", f.input.id + ".json"),
    path.join(f.directory, "lost.json"),
  );
  expect((await f.service.describe(session)).worktree?.state).toBe(
    "unavailable",
  );
  await expect(f.service.validate(session.workspace)).rejects.toThrow("不可用");
  await expect(
    f.service.validate(path.join(session.workspace, "subdir")),
  ).rejects.toThrow("子目录");
});

it("never replays a preparing record or an interrupted management lock", async () => {
  const f = await fixture();
  const session = await f.service.create(f.input, f.bind);
  const filename = path.join(f.directory, "worktrees", f.input.id + ".json");
  const record = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...record, state: "preparing" }));
  await expect(f.service.create(f.input, f.bind)).rejects.toThrow("不会回退");
  expect(
    await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
  ).toBe("base\n");
  await writeFile(
    path.join(f.directory, "worktrees", "creation.lock"),
    "unknown",
  );
  await expect(
    f.service.create({ ...f.input, id: randomUUID() }, f.bind),
  ).rejects.toThrow("未确认");
});

it("rejects non-repositories and invalid refs without publishing a session", async () => {
  const f = await fixture();
  await expect(f.service.inspect(f.directory)).rejects.toThrow(
    "Git 工作区根目录",
  );
  await expect(
    f.service.create({ ...f.input, baseRef: "--help" }, f.bind),
  ).rejects.toThrow("Git worktree");
  expect(f.sessions).toHaveLength(0);
});

it("resolves the selected commit once and suppresses checkout hooks", async () => {
  const f = await fixture();
  const oldCommit = await git(f.source, ["rev-parse", "HEAD"]);
  await writeFile(path.join(f.source, "tracked.txt"), "new commit\n");
  await git(f.source, ["add", "tracked.txt"]);
  await git(f.source, ["-c", "commit.gpgsign=false", "commit", "-m", "later"]);
  await writeFile(
    path.join(f.source, ".git", "hooks", "post-checkout"),
    "#!/bin/sh\nexit 73\n",
    { mode: 0o755 },
  );
  const session = await f.service.create(
    { ...f.input, baseRef: oldCommit },
    f.bind,
  );
  expect(session.worktree?.baseCommit).toBe(oldCommit);
  expect(
    await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
  ).toBe("base\n");
  const traceFiles = await readdir(
    path.join(f.directory, "worktrees", "traces", f.input.id),
  );
  const trace = await readFile(
    path.join(f.directory, "worktrees", "traces", f.input.id, traceFiles[0]!),
    "utf8",
  );
  expect(trace).toContain("worktree.create");
  expect(trace).not.toContain(oldCommit);
  expect(trace).not.toContain("tracked.txt");
});

it("blocks Git metadata that would expose Broker private data", async () => {
  const f = await fixture();
  const protectedData = path.join(f.source, ".git", "broker-data");
  const service = new WorktreeService(protectedData, log);
  currentTestResources().defer(() => service.close());
  await expect(service.create(f.input, f.bind)).rejects.toThrow(
    "私有数据目录重叠",
  );
  expect(f.sessions).toHaveLength(0);
});

it("checks private data overlap through a configured directory alias", async () => {
  const f = await fixture();
  const protectedData = path.join(f.source, ".git", "broker-data");
  await mkdir(protectedData);
  const alias = path.join(f.root, "private-alias");
  await symlink(
    protectedData,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const service = new WorktreeService(alias, log);
  currentTestResources().defer(() => service.close());
  await expect(service.create(f.input, f.bind)).rejects.toThrow(
    "私有数据目录重叠",
  );
});

it.skipIf(process.platform !== "win32")(
  "binds the canonical Windows checkout path so directory spelling cannot split the scheduling key",
  async () => {
    const f = await fixture();
    const service = new WorktreeService(f.directory.toUpperCase(), log);
    currentTestResources().defer(() => service.close());
    const session = await service.create(f.input, f.bind);
    expect(session.workspace).toBe(await realpath(session.workspace));
  },
);

it("stops a checkout filter process on shutdown and never replays its failed request", async () => {
  const f = await fixture();
  const marker = path.join(f.root, "filter-pid.txt");
  const script = path.join(f.root, "filter.cjs");
  await writeFile(
    script,
    `// Test-only hanging checkout filter; writes readiness before waiting.\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;
  await git(f.source, [
    "config",
    "filter.fixture.smudge",
    `${quote(process.execPath)} ${quote(script)}`,
  ]);
  await writeFile(
    path.join(f.source, ".gitattributes"),
    "tracked.txt filter=fixture\n",
  );
  await git(f.source, ["add", ".gitattributes"]);
  await git(f.source, ["-c", "commit.gpgsign=false", "commit", "-m", "filter"]);
  const creation = f.service.create(f.input, f.bind).then(
    () => undefined,
    (error: unknown) => error,
  );
  await expect
    .poll(async () => readFile(marker, "utf8").catch(() => ""))
    .not.toBe("");
  const pid = Number(await readFile(marker, "utf8"));
  await f.service.close();
  expect(await creation).toBeInstanceOf(Error);
  expect(() => process.kill(pid, 0)).toThrow();
  const restarted = new WorktreeService(f.directory, log);
  currentTestResources().defer(() => restarted.close());
  await expect(restarted.create(f.input, f.bind)).rejects.toThrow("不会回退");
  expect(f.sessions).toHaveLength(0);
});

it("shares the project memory key but leaves the session execution directory separate", async () => {
  const f = await fixture();
  const session = await f.service.create(f.input, f.bind);
  const memory = new ProjectMemoryService(f.directory, log, (workspace) =>
    f.service.projectWorkspace(workspace),
  );
  const created = await memory.apply(
    {
      workspace: session.workspace,
      sessionId: session.id,
      taskId: "fixture-task",
    },
    {
      operations: [
        {
          action: "create",
          kind: "constraint",
          title: "Shared project fact",
          statement: "Use the project build command.",
          tags: [],
          importance: "normal",
          confidence: "confirmed",
          expiresAt: null,
          source: {
            summary: "Fixture observation",
            eventId: null,
            filePath: null,
            fileHash: null,
          },
          reason: "Project wide constraint",
        },
      ],
    },
  );
  const source = await memory.retrieve(f.source);
  const checkout = await memory.retrieve(session.workspace);
  expect(checkout.available).toBe(true);
  expect(checkout).toEqual(source);
  expect(source.bundle?.entries[0]?.id).toBe(created.operations[0].id);
  const read = await memory.apply(
    { workspace: f.source, sessionId: session.id, taskId: "fixture-task" },
    {
      operations: [
        {
          action: "read",
          id: created.operations[0].id,
          expectedVersion: created.operations[0].version,
        },
      ],
    },
  );
  expect(read.projectKey).toBe(created.projectKey);
  expect(await f.service.projectWorkspace(session.workspace)).toBe(f.source);
  expect(session.workspace).not.toBe(f.source);
});

it("exposes stable metadata through HTTP/history and rejects execution after checkout removal", async () => {
  const f = await fixture();
  const app = await createApp(new Config(f.directory), log, () => ({
    async run() {
      return { output: [], text: "done" };
    },
  }));
  currentTestResources().defer(() => app.app.close());
  const bootstrap = await app.app.inject({
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1" },
  });
  const token = bootstrap.json().token;
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${token}`,
    "x-codeatelier-token": token,
  };
  const payload = {
    workspace: f.source,
    worktree: { id: f.input.id, baseRef: "refs/heads/main" },
  };
  const created = await app.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers,
    payload,
  });
  expect(created.statusCode).toBe(200);
  const session = created.json<Session>();
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers,
        payload,
      })
    ).json().id,
  ).toBe(session.id);
  const snapshot = await app.app.inject({
    url: `/api/sessions/${session.id}`,
    headers,
  });
  expect(snapshot.json().session.worktree.projectWorkspace).toBe(f.source);
  expect((await app.store.get(session.id))?.workspace).toBe(session.workspace);
  await rename(session.workspace, session.workspace + "-removed");
  const failed = await app.app.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/tasks`,
    headers,
    payload: { prompt: "do not run" },
  });
  expect(failed.statusCode).toBe(409);
  expect(failed.json().error).toContain("不会回退");
  expect(
    (await app.app.inject({ url: `/api/sessions/${session.id}`, headers }))
      .statusCode,
  ).toBe(200);
});

it("runs separate checkouts concurrently, queues the same checkout and resumes in place", async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, "AGENTS.md"), "SOURCE_DIRTY_RULE\n");
  const instructions: string[] = [];
  const app = await createApp(new Config(f.directory), log, () => ({
    async run(_input, rules, tools, signal) {
      if (!tools.length) {
        return { output: [], text: "fixture title" };
      }

      instructions.push(rules);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal.aborted) {
          reject(signal.reason);
        }
      });

      return { output: [], text: "" };
    },
  }));
  currentTestResources().defer(() => app.app.close());
  const first = await app.engine.worktrees.create(f.input, (workspace) =>
    app.store.createAsync(workspace),
  );
  const second = await app.engine.worktrees.create(
    { ...f.input, id: randomUUID() },
    (workspace) => app.store.createAsync(workspace),
  );
  const shared = await app.store.createAsync(first.workspace);
  const task1 = await app.engine.startAsync(first.id, "first");
  const task2 = await app.engine.startAsync(second.id, "second");
  const task3 = await app.engine.startAsync(shared.id, "shared");
  expect(task3.status).toBe("queued");
  await expect.poll(() => instructions.length).toBe(2);
  expect(
    instructions.every(
      (value) =>
        value.includes("WORKTREE_BASE_RULE") &&
        !value.includes("SOURCE_DIRTY_RULE"),
    ),
  ).toBe(true);
  await app.engine.cancelAsync(task1.id);
  await expect.poll(() => instructions.length).toBe(3);
  expect((await app.store.task(task2.id))?.status).toBe("running");
  await app.engine.cancelAsync(task3.id);
  const resumed = await app.engine.resumeAsync(task1.id);
  await expect.poll(() => instructions.length).toBe(4);
  expect(resumed.sessionId).toBe(first.id);
  expect((await app.store.get(first.id))?.workspace).toBe(first.workspace);
});

it("revalidates a queued checkout before executing and refuses recovery after it disappears", async () => {
  const f = await fixture();
  const config = new Config(f.directory);
  config.settings.maxConcurrentTasks = 1;
  let calls = 0;
  const app = await createApp(config, log, () => ({
    async run(_input, _rules, tools, signal) {
      if (!tools.length) {
        return { output: [], text: "fixture" };
      }

      calls++;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal.aborted) {
          reject(signal.reason);
        }
      });

      return { output: [], text: "" };
    },
  }));
  currentTestResources().defer(() => app.app.close());
  const local = await app.store.createAsync(f.source);
  const worktree = await app.engine.worktrees.create(f.input, (workspace) =>
    app.store.createAsync(workspace),
  );
  const running = await app.engine.startAsync(local.id, "hold");
  await expect.poll(() => calls).toBe(1);
  const queued = await app.engine.startAsync(worktree.id, "must not run");
  expect(queued.status).toBe("queued");
  await rename(worktree.workspace, worktree.workspace + "-moved");
  await app.engine.cancelAsync(running.id);
  await expect
    .poll(async () => (await app.store.task(queued.id))?.status)
    .toBe("failed");
  expect(calls).toBe(1);
  await expect(app.engine.resumeAsync(queued.id)).rejects.toThrow("不会回退");
});

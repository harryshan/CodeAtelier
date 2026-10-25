/**
 * 验证 Riftri 会话与现有系统的联动；只将原生卷操作替换为临时目录复制，不宣称物理 CoW。
 * 1. fixture 提供真实 Git、脏工作文件、暂存区、忽略/未跟踪文件及可重启服务。
 * 2. 检查独立 index/refs/文件、模式去重、记忆来源、Sandbox 根与失效目录拒绝。
 * 3. HTTP 验证默认 Riftri、显式 Worktree、禁止指定基线及失败现场；原生验证由 verify-riftri 在 WSL 执行。
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { WorktreeService } from "../src/worktrees/service.js";
import { git } from "../src/worktrees/git.js";
import { createApp } from "../src/server/app.js";
import { Config } from "../src/config/config.js";
import type { Session } from "../src/shared/types.js";
import { temp } from "./fixtures/helpers.js";
import { currentTestResources } from "./fixtures/test-resources.js";

vi.mock("../src/worktrees/riftri.js", async (original) => ({
  ...(await original<typeof import("../src/worktrees/riftri.js")>()),
  selectCheckout: async () => ({ backend: "riftri-reflink" }),
  createCheckout: async (source: string, destination: string) => {
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    return { backend: "riftri-reflink", clonedFiles: 4 };
  },
}));

async function fixture() {
  const root = await temp();
  const source = path.join(root, "source");
  const directory = path.join(root, "private");
  await mkdir(source);
  await mkdir(directory);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Snapshot fixture"]);
  await git(source, ["config", "user.email", "snapshot@example.invalid"]);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await writeFile(path.join(source, ".gitignore"), "ignored\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  await writeFile(path.join(source, "tracked.txt"), "staged\n");
  await git(source, ["add", "tracked.txt"]);
  await writeFile(path.join(source, "tracked.txt"), "dirty\n");
  await writeFile(path.join(source, "ignored"), "dependency\n");
  await writeFile(path.join(source, "untracked"), "new\n");
  const service = new WorktreeService(directory, pino({ enabled: false }));
  currentTestResources().defer(() => service.close());
  const sessions: Session[] = [];
  const bind = async (workspace: string) => {
    const existing = sessions.find(
      (session) => session.workspace === workspace,
    );
    if (existing) {
      return existing;
    }

    const session: Session = {
      id: randomUUID(),
      workspace,
      title: "test",
      titleState: "pending",
      createdAt: "now",
      updatedAt: "now",
    };
    sessions.push(session);

    return session;
  };

  return {
    source,
    directory,
    service,
    sessions,
    bind,
    input: { id: randomUUID(), workspace: source },
  };
}

it("preserves current bytes and staged state with independent Git and no source Sandbox grants", async () => {
  const f = await fixture();
  const before = await git(f.source, ["status", "--porcelain"]);
  const first = await f.service.createRiftri(f.input, f.bind);
  const second = await f.service.createRiftri(
    { ...f.input, id: randomUUID() },
    f.bind,
  );
  for (const session of [first, second]) {
    expect(
      await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
    ).toBe("dirty\n");
    expect(
      await readFile(path.join(session.workspace, "ignored"), "utf8"),
    ).toBe("dependency\n");
    expect(
      await readFile(path.join(session.workspace, "untracked"), "utf8"),
    ).toBe("new\n");
    expect(await git(session.workspace, ["show", ":tracked.txt"])).toBe(
      "staged",
    );
    expect(await git(session.workspace, ["status", "--porcelain"])).toBe(
      before,
    );
    expect(await f.service.gitWriteRoots(session.workspace)).toEqual([]);
    expect(await f.service.projectWorkspace(session.workspace)).toBe(f.source);
    expect(session.worktree?.mode).toBe("riftri");
  }

  await writeFile(path.join(first.workspace, "tracked.txt"), "agent\n");
  await git(first.workspace, ["add", "tracked.txt"]);
  await git(first.workspace, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "isolated",
  ]);
  expect(await git(first.workspace, ["rev-parse", "HEAD"])).not.toBe(
    await git(f.source, ["rev-parse", "HEAD"]),
  );
  expect(await git(second.workspace, ["show", ":tracked.txt"])).toBe("staged");
  expect(await readFile(path.join(f.source, "tracked.txt"), "utf8")).toBe(
    "dirty\n",
  );
});

it("reuses one snapshot on retries/restarts and rejects changing its mode or base", async () => {
  const f = await fixture();
  const first = await f.service.createRiftri(f.input, f.bind);
  await writeFile(path.join(first.workspace, "tracked.txt"), "keep");
  await writeFile(path.join(f.source, "tracked.txt"), "source changed");
  await f.service.close();
  const restarted = new WorktreeService(
    f.directory,
    pino({ enabled: false }),
    "missing",
  );
  currentTestResources().defer(() => restarted.close());
  const restored = await restarted.createRiftri(f.input, f.bind);
  expect(restored.id).toBe(first.id);
  expect(
    await readFile(path.join(restored.workspace, "tracked.txt"), "utf8"),
  ).toBe("keep");
  await expect(
    restarted.create({ ...f.input, baseRef: "HEAD" }, f.bind),
  ).rejects.toThrow("不能改变");
  await expect(
    restarted.createRiftri(
      { ...f.input, baseRef: "HEAD" } as typeof f.input,
      f.bind,
    ),
  ).rejects.toThrow("不能指定");
  await rename(restored.workspace, restored.workspace + "-moved");
  await expect(restarted.validate(restored.workspace)).rejects.toThrow(
    "不会回退",
  );
});

it("retains failed partial snapshots and never replays their request", async () => {
  const f = await fixture();
  // Destination collision is an observable partial-copy failure, not an injected success.
  await mkdir(path.join(f.service.root, f.input.id), { recursive: true });
  await writeFile(
    path.join(f.service.root, f.input.id, "tracked.txt"),
    "partial",
  );
  await expect(f.service.createRiftri(f.input, f.bind)).rejects.toThrow();
  const record = JSON.parse(
    await readFile(
      path.join(f.directory, "worktrees", f.input.id + ".json"),
      "utf8",
    ),
  );
  expect(record.state).toBe("failed");
  await expect(f.service.createRiftri(f.input, f.bind)).rejects.toThrow(
    "不会回退",
  );
  expect(f.sessions).toHaveLength(0);
});

it("defaults HTTP creation to Riftri while explicit Worktree retains committed content", async () => {
  const f = await fixture();
  const app = await createApp(
    new Config(f.directory),
    pino({ enabled: false }),
  );
  currentTestResources().defer(() => app.app.close());
  const token = (
    await app.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    })
  ).json().token;
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${token}`,
    "x-codeatelier-token": token,
  };
  const post = (payload: unknown) =>
    app.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
      payload: payload as object,
    });
  const response = await post({ workspace: f.source });
  expect(response.statusCode).toBe(200);
  const session = response.json<Session>();
  expect(session.worktree?.mode).toBe("riftri");
  expect(
    await readFile(path.join(session.workspace, "tracked.txt"), "utf8"),
  ).toBe("dirty\n");
  const worktree = await post({
    workspace: f.source,
    worktree: { id: randomUUID(), baseRef: "HEAD" },
  });
  expect(worktree.statusCode).toBe(200);
  expect(worktree.json().worktree).toMatchObject({
    mode: "worktree",
    backend: "git",
  });
  expect(
    await readFile(path.join(worktree.json().workspace, "tracked.txt"), "utf8"),
  ).toBe("base\n");
  expect(
    (
      await post({
        workspace: f.source,
        riftri: { id: randomUUID(), baseRef: "HEAD" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post({
        workspace: f.source,
        riftri: { id: randomUUID() },
        worktree: { id: randomUUID(), baseRef: "HEAD" },
      })
    ).statusCode,
  ).toBe(400);
});

it("runs two Riftri directories concurrently and resumes with their captured instructions", async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, "AGENTS.md"), "DIRTY_SNAPSHOT_RULE\n");
  const rules: string[] = [];
  const app = await createApp(
    new Config(f.directory),
    pino({ enabled: false }),
    () => ({
      async run(_input, instructions, tools, signal) {
        if (!tools.length) {
          return { output: [], text: "fixture title" };
        }

        rules.push(instructions);
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
    }),
  );
  currentTestResources().defer(() => app.app.close());
  const first = await app.engine.worktrees.createRiftri(f.input, (workspace) =>
    app.store.createAsync(workspace),
  );
  const second = await app.engine.worktrees.createRiftri(
    { ...f.input, id: randomUUID() },
    (workspace) => app.store.createAsync(workspace),
  );
  await writeFile(path.join(f.source, "AGENTS.md"), "LATER_SOURCE_RULE\n");
  const shared = await app.store.createAsync(first.workspace);
  const task1 = await app.engine.startAsync(first.id, "first");
  const task2 = await app.engine.startAsync(second.id, "second");
  const task3 = await app.engine.startAsync(shared.id, "shared");
  expect(task3.status).toBe("queued");
  await expect.poll(() => rules.length).toBe(2);
  expect(
    rules.every(
      (value) =>
        value.includes("DIRTY_SNAPSHOT_RULE") &&
        !value.includes("LATER_SOURCE_RULE"),
    ),
  ).toBe(true);
  await app.engine.cancelAsync(task1.id);
  await expect.poll(() => rules.length).toBe(3);
  expect((await app.store.task(task2.id))?.status).toBe("running");
  await app.engine.cancelAsync(task3.id);
  const resumed = await app.engine.resumeAsync(task1.id);
  await expect.poll(() => rules.length).toBe(4);
  expect(resumed.sessionId).toBe(first.id);
  expect((await app.store.get(first.id))?.workspace).toBe(first.workspace);
});

it("rejects a snapshot manifest redirected to source Git and preserves plain non-Git directories", async () => {
  const f = await fixture();
  const session = await f.service.createRiftri(f.input, f.bind);
  const file = path.join(f.directory, "worktrees", f.input.id + ".json");
  const record = JSON.parse(await readFile(file, "utf8"));
  record.commonDirectory = path.join(f.source, ".git");
  await writeFile(file, JSON.stringify(record));
  await expect(f.service.validate(session.workspace)).rejects.toThrow(
    "不会回退",
  );
  const plain = await temp();
  await writeFile(path.join(plain, "draft"), "no Git required");
  const copied = await f.service.createRiftri(
    { id: randomUUID(), workspace: plain },
    f.bind,
  );
  expect(await readFile(path.join(copied.workspace, "draft"), "utf8")).toBe(
    "no Git required",
  );
  expect(await f.service.gitWriteRoots(copied.workspace)).toEqual([]);
});

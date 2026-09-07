import { describe, it, expect, afterEach } from "vitest";
import {
  realpath,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalManager } from "../src/permissions/approvals.js";
import { ToolRunner } from "../src/tools/registry.js";
import { Config } from "../src/config/settings.js";
import { Store } from "../src/sessions/store.js";
import { executeProcess } from "../src/tools/process.js";
import { Engine } from "../src/agent/engine.js";
import { createApp } from "../src/server/app.js";
import pino from "pino";
import { redactText } from "../src/logging/logger.js";
const cleanup: string[] = [];
async function temp() {
  const p = await mkdtemp(path.join(tmpdir(), "codeatelier-"));
  cleanup.push(p);
  return realpath(p);
}
afterEach(async () => {
  for (const p of cleanup.splice(0))
    await rm(p, { recursive: true, force: true });
});
function runner(
  root: string,
  config: Config,
  approvals = new ApprovalManager(() => {}),
  signal = new AbortController().signal,
) {
  return new ToolRunner({
    root,
    sessionId: "s",
    taskId: "t",
    signal,
    settings: config.settings,
    approvals,
    emit: () => {},
  });
}
describe("files and permissions", () => {
  it("requires reading existing files and rejects concurrent changes", async () => {
    const root = await temp();
    const config = new Config(await temp());
    await writeFile(path.join(root, "a.txt"), "old");
    const tools = runner(root, config);
    await expect(
      tools.execute("edit_file", {
        path: "a.txt",
        oldText: "old",
        newText: "new",
      }),
    ).rejects.toThrow("未读取");
    await tools.execute("read_file", {
      path: "a.txt",
      startLine: 1,
      endLine: 10,
    });
    await writeFile(path.join(root, "a.txt"), "other");
    await expect(
      tools.execute("edit_file", {
        path: "a.txt",
        oldText: "old",
        newText: "new",
      }),
    ).rejects.toThrow("已变化");
  });
  it("writes exact replacement and reports diff", async () => {
    const root = await temp();
    const tools = runner(root, new Config(await temp()));
    await tools.execute("write_file", { path: "a.txt", content: "abc" });
    const result = await tools.execute("edit_file", {
      path: "a.txt",
      oldText: "b",
      newText: "B",
    });
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("aBc");
    expect(result.diff).toContain("+aBc");
  });
  it("blocks external writes until approval and denial leaves file absent", async () => {
    const root = await temp(),
      outside = await temp();
    const approvals = new ApprovalManager(() => {});
    const tools = runner(root, new Config(await temp()), approvals);
    const pending = tools.execute("write_file", {
      path: path.join(outside, "x.txt"),
      content: "no",
    });
    await waitFor(() => approvals.list().length === 1);
    approvals.decide(approvals.list()[0].id, "deny");
    await expect(pending).rejects.toThrow("拒绝");
    await expect(readFile(path.join(outside, "x.txt"))).rejects.toThrow();
  });
  it("recognizes directory links escaping workspace", async () => {
    const root = await temp(),
      outside = await temp();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(
      outside,
      path.join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const approvals = new ApprovalManager(() => {});
    const tools = runner(root, new Config(await temp()), approvals);
    const pending = tools.execute("read_file", {
      path: "link/secret.txt",
      startLine: 1,
      endLine: 10,
    });
    await waitFor(() => approvals.list().length === 1);
    approvals.decide(approvals.list()[0].id, "deny");
    await expect(pending).rejects.toThrow("拒绝");
  });
  it("cancels a pending approval", async () => {
    const approvals = new ApprovalManager(() => {});
    const controller = new AbortController();
    const pending = approvals.request(
      { sessionId: "s", taskId: "t", tool: "run_command", description: "test" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("取消");
    expect(approvals.list()).toEqual([]);
  });
});
export async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition timeout");
}
describe("execution and persistence", () => {
  it("terminates timed out commands", async () => {
    const root = await temp();
    await expect(
      executeProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        root,
        new AbortController().signal,
        100,
        2000,
        () => {},
      ),
    ).rejects.toThrow("超时");
  });
  it("limits output while preserving exit status", async () => {
    const root = await temp();
    const result = await executeProcess(
      process.execPath,
      ["-e", 'console.log("x".repeat(10000));process.exitCode=3'],
      root,
      new AbortController().signal,
      2000,
      100,
      () => {},
    );
    expect(result.output.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(3);
  });
  it("persists conversations and marks unfinished tasks interrupted after restart", async () => {
    const root = await temp();
    const file = path.join(root, "history.sqlite");
    const first = new Store(file);
    const session = first.create(root, "test");
    const task = first.createTask(session.id);
    first.event(session.id, task.id, "user", { text: "hello" });
    first.close();
    const second = new Store(file);
    expect(second.events(session.id)[0].data.text).toBe("hello");
    expect(second.tasks(session.id)[0].status).toBe("interrupted");
    second.close();
  });
  it("completes a model/tool loop and rejects concurrent tasks", async () => {
    const root = await temp();
    const config = new Config(await temp());
    const store = new Store(path.join(config.directory, "db"));
    const session = store.create(root, "test");
    let calls = 0;
    const engine = new Engine(store, config, pino({ enabled: false }), () => ({
      async run() {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return calls === 1
          ? {
              output: [
                {
                  type: "function_call",
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "hello.txt",
                    content: "hello",
                  }),
                  call_id: "call1",
                },
              ],
              text: "",
            }
          : {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "完成" }],
                },
              ],
              text: "完成",
            };
      },
    }));
    engine.start(session.id, "write");
    expect(() => engine.start(session.id, "second")).toThrow("已有任务");
    await engine.active!.done;
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("hello");
    expect(store.tasks(session.id)[0].status).toBe("completed");
    expect(
      store.context(session.id).some((i) => i.type === "function_call_output"),
    ).toBe(true);
    store.close();
  });
});
describe("server security and configuration", () => {
  it("rejects foreign origins, hosts and missing tokens; never exposes key", async () => {
    const config = new Config(await temp());
    config.apiKey = "test-secret-key";
    const { app } = await createApp(config, pino({ enabled: false }));
    try {
      expect(
        (
          await app.inject({
            url: "/api/bootstrap",
            headers: { host: "evil.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/bootstrap",
            headers: { host: "127.0.0.1", origin: "https://evil.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/settings",
            headers: { host: "127.0.0.1" },
          })
        ).statusCode,
      ).toBe(401);
      const result = await app.inject({
        url: "/api/bootstrap",
        headers: { host: "127.0.0.1" },
      });
      expect(result.body).not.toContain("test-secret-key");
      const token = result.json().token;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: { host: "127.0.0.1", cookie: "ca_session=" + token },
            payload: { workspace: config.directory, title: "x" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("keeps API key out of settings file", async () => {
    const config = new Config(await temp());
    config.update({ settings: config.settings, apiKey: "do-not-persist" });
    expect(
      await readFile(path.join(config.directory, "settings.json"), "utf8"),
    ).not.toContain("do-not-persist");
  });
  it("redacts configured secrets and authorization tokens", () => {
    expect(
      redactText("Bearer token123 key=super-secret", ["super-secret"]),
    ).not.toContain("token123");
    expect(redactText("super-secret", ["super-secret"])).toBe("[REDACTED]");
  });
});

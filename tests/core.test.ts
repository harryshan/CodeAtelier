/**
 * 覆盖文件权限、模型调用工具、历史保存和本机 HTTP 安全的基础流程。
 * 测试使用临时目录、真实数据库和模拟模型。
 *
 * 1. temp/runner 准备并在用例后关闭工具/临时目录；files and permissions 检查 shell/search 检测、Runtime 专属指引分流、先读后写、越界和取消。
 * 2. waitFor 等待任务结束；execution and persistence 检查超时、输出限制和工具执行。
 * 3. server security and configuration 检查请求来源、凭据和脱敏。
 *
 * 需要特定平台能力的链接测试会明确跳过，不能把一次平台上的通过当作全平台验证。
 */

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
import { ApprovalManager } from "../src/permissions/approval-manager.js";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { executeProcess } from "../src/tools/process.js";
import { Engine } from "../src/agent/engine.js";
import {
  createInstructions,
  detectWindowsShell,
} from "../src/agent/instructions.js";
import { commandShell } from "../src/tools/command-shell.js";
import { detectSearchCommands } from "../src/tools/search-commands.js";
import { createApp } from "../src/server/app.js";
import pino from "pino";
import { redactText } from "../src/logging/redact.js";

const cleanup: string[] = [];
const activeRunners: ToolRunner[] = [];

async function temp() {
  const p = await mkdtemp(path.join(tmpdir(), "codeatelier-"));

  cleanup.push(p);

  return realpath(p);
}

afterEach(async () => {
  await Promise.all(activeRunners.splice(0).map((runner) => runner.close()));
  for (const p of cleanup.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

function runner(
  root: string,
  config: Config,
  approvals = new ApprovalManager(() => {}),
  signal = new AbortController().signal,
) {
  const toolRunner = new ToolRunner({
    root,
    sessionId: "s",
    taskId: "t",
    signal,
    settings: config.settings,
    approvals,
    emit: () => {},
  });
  activeRunners.push(toolRunner);

  return toolRunner;
}

describe("files and permissions", () => {
  it("prefers PowerShell 7 when it is available on Windows", () => {
    const environment = {
      Path: "C:\\Tools;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    };
    const shell = detectWindowsShell(
      environment,
      (candidate) => candidate === "C:\\Tools\\pwsh.exe",
      "win32",
    );

    expect(shell).toEqual({
      command: "C:\\Tools\\pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    });
  });

  it("adds capability guidance only for the actual Agent Runtime", async () => {
    const hostInstructions = await createInstructions(await temp());
    const runtimeInstructions = await createInstructions(
      await temp(),
      undefined,
      true,
    );

    expect(hostInstructions).not.toContain("run_with_permissions");
    expect(hostInstructions).not.toContain("Windows Agent Runtime");
    expect(runtimeInstructions).toContain("run_with_permissions");
    expect(runtimeInstructions).toContain("Windows Agent Runtime");
  });

  it("detects performance-ordered search commands before building instructions", async () => {
    const windows = detectSearchCommands(
      { Path: "C:\\Tools", SystemRoot: "C:\\Windows" },
      (candidate) =>
        [
          "C:\\Tools\\rg.exe",
          "C:\\Tools\\grep.exe",
          "C:\\Windows\\System32\\findstr.exe",
        ].includes(candidate),
      "win32",
    );
    const instructions = await createInstructions(await temp(), windows);

    expect(windows).toEqual([
      { command: "rg", purpose: "content" },
      { command: "grep", purpose: "content" },
      { command: "findstr", purpose: "content" },
    ]);
    expect(instructions).toContain(
      "repository search commands available through run_command, ordered by estimated performance: `rg` (content), `grep` (content), `findstr` (content)",
    );

    const powershell = detectSearchCommands(
      { Path: "C:\\Tools" },
      (candidate) => candidate === "C:\\Tools\\powershell.exe",
      "win32",
    );
    const posix = detectSearchCommands(
      { PATH: "/usr/bin:/bin" },
      (candidate) =>
        ["/usr/bin/ugrep", "/bin/grep", "/usr/bin/fd", "/bin/find"].includes(
          candidate,
        ),
      "linux",
    );

    expect(powershell).toEqual([
      { command: "Select-String", purpose: "content" },
    ]);
    expect(posix).toEqual([
      { command: "ugrep", purpose: "content" },
      { command: "grep", purpose: "content" },
      { command: "fd", purpose: "filenames" },
      { command: "find", purpose: "filenames" },
    ]);
  });

  it("uses a fixed POSIX shell internally", () => {
    expect(
      commandShell({}, (candidate) => candidate === "/bin/sh", "linux"),
    ).toEqual({
      command: "/bin/sh",
      args: ["-c"],
    });
  });

  it("falls back to powershell when pwsh is unavailable", () => {
    const shell = detectWindowsShell(
      { SystemRoot: "C:\\Windows" },
      (candidate) =>
        candidate ===
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "win32",
    );

    expect(shell).toEqual({
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    });
  });

  it("falls back to cmd only when higher-priority shells are unavailable", () => {
    const shell = detectWindowsShell(
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
      "win32",
    );

    expect(shell).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c"],
    });
  });

  it("requires reading existing files and rejects concurrent changes", async () => {
    const root = await temp();
    const config = new Config(await temp());

    await writeFile(path.join(root, "a.txt"), "old");
    const tools = runner(root, config);

    const unread = await tools.execute("edit_files", {
      files: [
        {
          path: "a.txt",
          create: false,
          edits: [{ oldText: "old", newText: "new" }],
        },
      ],
    });
    expect(unread.error).toContain("未读取");
    await tools.execute("read_file", {
      path: "a.txt",
      startLine: 1,
      endLine: 10,
    });
    await writeFile(path.join(root, "a.txt"), "other");

    const stale = await tools.execute("edit_files", {
      files: [
        {
          path: "a.txt",
          create: false,
          edits: [{ oldText: "old", newText: "new" }],
        },
      ],
    });
    expect(stale.error).toContain("已变化");
  });
  it("blocks external writes until approval and denial leaves file absent", async () => {
    const root = await temp();
    const outside = await temp();
    const approvals = new ApprovalManager(() => {});
    const tools = runner(root, new Config(await temp()), approvals);
    const pending = tools.execute("edit_files", {
      files: [
        { path: path.join(outside, "x.txt"), create: true, content: "no" },
      ],
    });

    await waitFor(() => approvals.list().length === 1);
    approvals.decide(approvals.list()[0].id, "deny");

    const result = await pending;
    expect(result.error).toContain("拒绝");
    await expect(readFile(path.join(outside, "x.txt"))).rejects.toThrow();
  });
  it("recognizes directory links escaping workspace", async () => {
    const root = await temp();
    const outside = await temp();

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
    if (check()) {
      return;
    }

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
  it("completes a model/tool loop and rejects a second task in the same session", async () => {
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
                  name: "edit_files",
                  arguments: JSON.stringify({
                    files: [
                      { path: "hello.txt", create: true, content: "hello" },
                    ],
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

    expect(() => engine.start(session.id, "second")).toThrow("当前会话已有");
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
  it("accepts trusted LAN hosts only when network listening is explicitly enabled", async () => {
    const config = new Config(await temp());
    const { app } = await createApp(
      config,
      pino({ enabled: false }),
      undefined,
      undefined,
      undefined,
      true,
    );

    try {
      expect(
        (
          await app.inject({
            url: "/api/bootstrap",
            headers: {
              host: "192.168.1.10:4142",
              origin: "http://192.168.1.10:4142",
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            url: "/api/bootstrap",
            headers: {
              host: "192.168.1.10:4142",
              origin: "https://evil.example",
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: "/api/bootstrap",
            headers: { host: "invalid[" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("redacts configured secrets and authorization tokens", () => {
    expect(
      redactText("Bearer token123 key=super-secret", ["super-secret"]),
    ).not.toContain("token123");
    expect(redactText("super-secret", ["super-secret"])).toBe("[REDACTED]");
  });
});

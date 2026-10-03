/**
 * 回归 Windows taskkill 尚在启动时抢先杀父进程造成的孤儿子进程和关闭挂起。
 *
 * 1. 仅替换 taskkill 启动为延迟代理，最终仍调用真实 Windows taskkill /T /F；其它进程均真实运行。
 * 2. PowerShell 父进程启动继承输出句柄的常驻 Node 子进程；分别通过 pipe/file-backed 执行器取消整棵树。
 * 3. 断言取消正常完成、后代退出、输出目录释放；安全计时器只清理本测试创建的 PID，其触发本身使测试失败。
 * 非 Windows 跳过这两个平台专属用例，不将本机验证描述为全平台进程隔离保证。
 */
import { expect, it, vi } from "vitest";
import type { SpawnOptions } from "node:child_process";
import { readdir } from "node:fs/promises";
import {
  executeProcess,
  executeProcessFileBacked,
} from "../src/tools/process.js";
import { detectWindowsShell } from "../src/tools/command-shell.js";
import { temp } from "./fixtures/helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn(
      command: string,
      args: readonly string[] = [],
      options: SpawnOptions = {},
    ) {
      if (command === "taskkill") {
        const proxy = `
          setTimeout(() => {
            const child = require('node:child_process').spawn('taskkill', process.argv.slice(1), { stdio: 'ignore', windowsHide: true });
            child.on('error', () => process.exit(1));
            child.on('close', code => process.exit(code ?? 1));
          }, 1500);
        `;

        return actual.spawn(process.execPath, ["-e", proxy, ...args], options);
      }

      return actual.spawn(command, args, options);
    },
  };
});

function stopFixture(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

it.skipIf(process.platform !== "win32").each(["pipe", "file-backed"])(
  "waits for delayed taskkill to stop descendants before releasing %s output",
  async (mode) => {
    const directory = await temp();
    const controller = new AbortController();
    let parentPid: number | undefined;
    let descendantPid: number | undefined;
    let forcedCleanup = false;
    let text = "";
    const script = `& '${process.execPath.replaceAll("'", "''")}' -e 'console.log(process.pid);setInterval(()=>{},1000)'`;
    const shell = detectWindowsShell()!;
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ];
    const onOutput = (chunk: string) => {
      text += chunk;
      const match = text.match(/^(\d+)\r?\n/);
      if (match) {
        descendantPid = Number(match[1]);
      }

      if (descendantPid) {
        controller.abort();
      }
    };

    const onPid = (pid: number) => {
      parentPid = pid;
    };

    const safety = setTimeout(() => {
      forcedCleanup = true;
      stopFixture(descendantPid);
      stopFixture(parentPid);
    }, 8000);

    try {
      const operation =
        mode === "pipe"
          ? executeProcess(
              shell.command,
              args,
              directory,
              controller.signal,
              10000,
              1000,
              onOutput,
              {},
              onPid,
            )
          : executeProcessFileBacked(
              shell.command,
              args,
              directory,
              controller.signal,
              10000,
              1000,
              onOutput,
              directory,
              {},
              onPid,
            );
      await expect(operation).rejects.toThrow("任务已取消");
      expect(forcedCleanup).toBe(false);
      expect(descendantPid).toBeGreaterThan(0);
      expect(() => process.kill(descendantPid!, 0)).toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      clearTimeout(safety);
      stopFixture(descendantPid);
      stopFixture(parentPid);
    }
  },
);

/**
 * 回归 Windows taskkill 尚在启动时抢先杀父进程造成的孤儿子进程和关闭挂起。
 *
 * 1. 仅替换 taskkill 启动为延迟代理，最终仍调用真实 Windows taskkill /T /F；其它进程均真实运行。
 * 2. 真实 Node 父进程启动继承输出句柄的常驻 Node 子进程；分别通过 pipe/file-backed 执行器取消整棵树，避免 PowerShell 冷启动干扰取消阶段。
 * 3. 启动和取消各有八秒安全期限；收到后代 PID 后才开始取消期限，避免冷启动消耗清理时间并抢先干扰 taskkill。
 * 4. 断言取消正常完成、后代退出、输出目录释放；安全清理只针对本测试 PID，触发即失败，finally 还等待延迟代理退出。
 * 非 Windows 跳过这两个平台专属用例，不将本机验证描述为全平台进程隔离保证。
 */
import { expect, it, vi } from "vitest";
import type { SpawnOptions } from "node:child_process";
import { readdir } from "node:fs/promises";
import {
  executeProcess,
  executeProcessFileBacked,
} from "../src/tools/process.js";
import { temp } from "./fixtures/helpers.js";

const killerCompletions = vi.hoisted(() => [] as Promise<void>[]);

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

        const killer = actual.spawn(
          process.execPath,
          ["-e", proxy, ...args],
          options,
        );
        killerCompletions.push(
          new Promise<void>((resolve) => killer.once("close", () => resolve())),
        );

        return killer;
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
    let safety: NodeJS.Timeout | undefined;
    const forceCleanup = () => {
      forcedCleanup = true;
      stopFixture(descendantPid);
      stopFixture(parentPid);
    };

    const script = `
      const child = require('node:child_process').spawn(
        process.execPath,
        ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'],
        { stdio: 'inherit', windowsHide: true }
      );
      child.on('error', () => process.exit(1));
      child.on('exit', code => process.exit(code ?? 1));
    `;
    const args = ["-e", script];
    const onOutput = (chunk: string) => {
      text += chunk;
      const match = text.match(/^(\d+)\r?\n/);
      if (match && descendantPid === undefined) {
        descendantPid = Number(match[1]);
        // 八秒清理期限从真实取消开始，启动期仍由自己的八秒安全期限保护。
        clearTimeout(safety);
        safety = setTimeout(forceCleanup, 8000);
        controller.abort();
      }
    };

    const onPid = (pid: number) => {
      parentPid = pid;
    };

    safety = setTimeout(forceCleanup, 8000);

    try {
      const operation =
        mode === "pipe"
          ? executeProcess(
              process.execPath,
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
              process.execPath,
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
      await Promise.all(killerCompletions.splice(0));
    }
  },
);

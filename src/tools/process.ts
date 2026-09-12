/**
 * 文件作用：执行受控命令并收集有界输出、退出状态和取消结果。
 * 代码结构：executeProcess 启动无 shell 子进程，设置跨平台进程树终止与超时，再解码输出并在错误或退出时清理监听和计时器。
 */

import { spawn } from "node:child_process";

export async function executeProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (s: string) => void,
) {
  signal.throwIfAborted();

  return new Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CODEATELIER_API_KEY: undefined },
    });
    let output = "";
    let size = 0;
    let stopped = false;
    let timedOut = false;
    let finished = false;
    // 终止整棵进程树，避免任务结束后测试或构建子进程仍继续运行。
    const stop = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (child.pid) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    signal.addEventListener("abort", stop, { once: true });
    // 使用流解码器保留跨 chunk 的 UTF-8 字符，不能单独转换每个 Buffer。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (chunk: string) => {
      const text = chunk;

      size += text.length;
      const accepted = text.slice(0, Math.max(0, outputLimit - output.length));

      output += accepted;
      if (accepted) {
        onOutput(accepted);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };

    child.on("error", () => {
      if (finished) {
        return;
      }

      cleanup();
      reject(new Error("无法启动命令，请检查可执行文件或 shell 路径。"));
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }

      cleanup();
      if (signal.aborted) {
        reject(new Error("任务已取消"));
      } else if (timedOut) {
        reject(new Error("命令超时，已终止进程树。"));
      } else {
        resolve({ output, exitCode: code, truncated: size > outputLimit });
      }
    });
  });
}

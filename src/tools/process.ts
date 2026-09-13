/**
 * 执行已经获批的命令，向 ToolRunner 返回输出、退出码和截断状态。
 * 调用方提供程序、参数、工作目录、取消信号及输出限制。
 *
 * 1. spawn 不经过 shell，隐藏 Windows 窗口，并从子进程环境中移除模型密钥。
 * 2. stop 在 Windows 使用 taskkill，在 Unix 使用进程组终止子进程树；超时和取消都走这里。
 * 3. stdout、stderr 按 UTF-8 流式解码，append 保留限额内的内容并通知调用方。
 * 4. error 和 close 清理计时器及监听，返回结果或抛出取消、超时等错误。
 *
 * 输出太长时只截断保存内容。非零退出码照实返回，命令是否获准由执行前的审批负责。
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

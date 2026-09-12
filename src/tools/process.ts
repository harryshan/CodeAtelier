/**
 * 文件作用：执行受控命令并收集有界输出、退出状态和取消结果。
 *
 * 模块协作与输入输出：
 * 由 ToolRunner 在批准 run_command 后调用，输入可执行文件、参数、目录、取消及输出限制。
 *
 * 代码结构与执行顺序：
 * 1. spawn 使用 shell:false，隐藏 Windows 窗口，并从继承环境中移除模型密钥。
 * 2. stop 按 Windows taskkill 或 Unix 进程组方式终止进程树，超时与取消共用此入口。
 * 3. stdout/stderr 使用流式 UTF-8 解码，append 截取可接受输出并通知调用方。
 * 4. error/close 分支统一清理计时器和监听，返回退出码、输出及截断状态或抛出终止原因。
 *
 * 关键约束：
 * 只限制保留输出，不把非零退出码改成成功；是否允许执行命令由调用前的审批决定。
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

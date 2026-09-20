/**
 * 执行已经获批的命令，向 ToolRunner 返回纯文本输出、退出码和截断状态。
 * 调用方提供程序、参数、工作目录、取消信号及输出限制。
 *
 * 1. TerminalTextSanitizer 在每个 stdout/stderr 流内跨 chunk 去除 ANSI、OSC 等终端控制序列，
 *    避免颜色和标题控制符进入会话记录；子进程环境同时请求常见工具禁用颜色。
 * 2. spawn 不经过 shell，隐藏 Windows 窗口，并从子进程环境中移除模型密钥；调用方可追加受限环境变量。
 * 3. onProcessStarted 在子进程获得 PID 后立即回传，使 session 能在命令结束前持久化恢复身份。
 * 4. stop 在 Windows 使用 taskkill，在 Unix 使用进程组终止子进程树；超时和取消都走这里。
 * 5. stdout、stderr 按 UTF-8 流式解码，append 保留限额内的可见内容并通知调用方。
 * 6. error 和 close 清理计时器及监听，返回结果或抛出取消、超时等错误；启动失败会保留子进程实际报错。
 *
 * 输出太长时只截断保存内容。非零退出码及 shell 写入 stderr 的实际错误照实返回，命令是否获准由执行前的审批负责。
 */

import { spawn } from "node:child_process";

type TerminalControlState =
  "text" | "escape" | "csi" | "string" | "stringEscape";

/**
 * 终端控制序列可能被流任意拆分，不能对每个 chunk 单独正则替换。
 * 此状态机只保留可见字符；CSI 以最终字节结束，OSC/DCS 等字符串以 BEL 或 ST 结束。
 */
export class TerminalTextSanitizer {
  private state: TerminalControlState = "text";

  write(chunk: string) {
    let plainText = "";

    for (const character of chunk) {
      if (this.state === "text") {
        if (character === "\u001b") {
          this.state = "escape";
        } else if (character === "\u009b") {
          this.state = "csi";
        } else if (character === "\u009d") {
          this.state = "string";
        } else {
          plainText += character;
        }
      } else if (this.state === "escape") {
        if (character === "[") {
          this.state = "csi";
        } else if (
          character === "]" ||
          ["P", "X", "^", "_"].includes(character)
        ) {
          this.state = "string";
        } else {
          this.state = "text";
        }
      } else if (this.state === "csi") {
        const code = character.charCodeAt(0);

        if (code >= 0x40 && code <= 0x7e) {
          this.state = "text";
        }
      } else if (this.state === "string") {
        if (character === "\u0007") {
          this.state = "text";
        } else if (character === "\u001b") {
          this.state = "stringEscape";
        }
      } else if (character === "\\" || character === "\u0007") {
        this.state = "text";
      } else if (character !== "\u001b") {
        this.state = "string";
      }
    }

    return plainText;
  }
}

export async function executeProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (s: string) => void,
  environment: NodeJS.ProcessEnv = {},
  onProcessStarted?: (pid: number) => void,
  standardInput?: Buffer,
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
      env: {
        ...process.env,
        // 常见 Node、CLI 和终端约定；流清理器兜底处理不遵守约定的程序。
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
        TERM: "dumb",
        ...environment,
        CODEATELIER_API_KEY: undefined,
      },
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

    if (child.pid !== undefined && onProcessStarted) {
      try {
        onProcessStarted(child.pid);
      } catch (error) {
        stop();
        child.on("error", () => {});
        child.on("close", () => {});
        reject(error);

        return;
      }
    }

    if (standardInput) {
      child.stdin.end(standardInput);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    signal.addEventListener("abort", stop, { once: true });
    // 使用流解码器保留跨 chunk 的 UTF-8 字符，不能单独转换每个 Buffer。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const stdoutText = new TerminalTextSanitizer();
    const stderrText = new TerminalTextSanitizer();
    const append = (sanitizer: TerminalTextSanitizer, chunk: string) => {
      const text = sanitizer.write(chunk);

      size += text.length;
      const accepted = text.slice(0, Math.max(0, outputLimit - output.length));

      output += accepted;
      if (accepted) {
        onOutput(accepted);
      }
    };

    child.stdout.on("data", (chunk) => append(stdoutText, chunk));
    child.stderr.on("data", (chunk) => append(stderrText, chunk));
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      cleanup();
      const detail =
        error instanceof Error && error.message
          ? error.message
          : "子进程未提供详细错误信息。";

      reject(
        new Error(
          `无法启动命令，请检查可执行文件或 shell 路径。实际错误：${detail}`,
        ),
      );
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

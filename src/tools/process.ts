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
 * 6. 输出/PID 回调和管道错误先停止子进程，等待 close 后再拒绝调用，避免未捕获异常结束整个服务；close 清理计时器和取消监听。
 * 7. 可选的进程创建返回回调只供已安装 Runtime 的固定阶段诊断使用，不传递命令、参数或输出。
 * 8. Windows 专用账户 Runtime 的 file-backed 入口避开 libuv 创建默认 stdio 命名管道的同步路径；在实例 TEMP 中独占创建输出文件，定时读取并施加磁盘上限，结束后关闭句柄和删除文件。
 *
 * 输出太长时只截断保存内容。非零退出码及 shell 写入 stderr 的实际错误照实返回，命令是否获准由执行前的审批负责。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

const FILE_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const FILE_OUTPUT_POLL_MS = 100;

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
  onSpawnReturned?: () => void,
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
    let failed = false;
    let failure: unknown;
    // 终止整棵进程树，避免任务结束后测试或构建子进程仍继续运行。
    const stop = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            {
              windowsHide: true,
              stdio: "ignore",
            },
          );
          const fallback = setTimeout(() => child.kill(), 1_000);

          fallback.unref();
          killer.once("error", () => {
            clearTimeout(fallback);
            child.kill();
          });
          killer.once("close", (code) => {
            clearTimeout(fallback);
            if (code !== 0) {
              child.kill();
            }
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    };

    const fail = (error: unknown) => {
      if (finished || failed) {
        return;
      }

      failed = true;
      failure = error;
      stop();
    };

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
      if (failed || finished) {
        return;
      }

      const text = sanitizer.write(chunk);

      size += text.length;
      const accepted = text.slice(0, Math.max(0, outputLimit - output.length));

      output += accepted;
      if (accepted) {
        try {
          onOutput(accepted);
        } catch (error) {
          fail(error);
        }
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
      if (failed) {
        reject(failure);
      } else if (signal.aborted) {
        reject(new Error("任务已取消"));
      } else if (timedOut) {
        reject(new Error("命令超时，已终止进程树。"));
      } else {
        resolve({ output, exitCode: code, truncated: size > outputLimit });
      }
    });

    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    // 先装好所有监听，再交给可能失败或触发取消的持久化回调。
    try {
      onSpawnReturned?.();

      if (child.pid !== undefined) {
        onProcessStarted?.(child.pid);
      }

      if (signal.aborted) {
        stop();
      }

      if (standardInput && !stopped) {
        child.stdin.end(standardInput);
      }
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * 专用账户下 Node/libuv 的默认 stdio pipe 创建可能同步卡住，使 AbortSignal 和超时器都无法运行。
 * 这里只改变工具输出传输方式；进程仍继承同一 restricted token/Job，并在关闭前保持取消和 PID 账本回调。
 */
export async function executeProcessFileBacked(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (text: string) => void,
  outputDirectory: string,
  environment: NodeJS.ProcessEnv = {},
  onProcessStarted?: (pid: number) => void,
  onSpawnReturned?: () => void,
) {
  signal.throwIfAborted();
  const privateDirectory = await mkdtemp(
    path.join(outputDirectory, "codeatelier-command-output-"),
  );
  let outputFile: FileHandle | undefined;

  try {
    outputFile = await open(
      path.join(privateDirectory, "output"),
      "wx+",
      0o600,
    );
    process.stderr.write(
      "CODEATELIER_AGENT_RUNTIME_STAGE command_spool_ready\n",
    );

    return await runFileBackedProcess(
      command,
      args,
      cwd,
      signal,
      timeoutMs,
      outputLimit,
      onOutput,
      outputFile,
      environment,
      onProcessStarted,
      onSpawnReturned,
    );
  } finally {
    try {
      await outputFile?.close();
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
    }
  }
}

function runFileBackedProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (text: string) => void,
  outputFile: FileHandle,
  environment: NodeJS.ProcessEnv,
  onProcessStarted?: (pid: number) => void,
  onSpawnReturned?: () => void,
) {
  return new Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", outputFile.fd, outputFile.fd],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
        TERM: "dumb",
        ...environment,
        CODEATELIER_API_KEY: undefined,
      },
    });
    const decoder = new StringDecoder("utf8");
    const sanitizer = new TerminalTextSanitizer();
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let output = "";
    let outputSize = 0;
    let readPosition = 0;
    let stopped = false;
    let timedOut = false;
    let finished = false;
    let failure: unknown;
    let drain = Promise.resolve();

    const stop = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (!child.pid) {
        return;
      }

      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        const fallback = setTimeout(() => child.kill(), 1_000);

        fallback.unref();
        killer.once("error", () => {
          clearTimeout(fallback);
          child.kill();
        });
        killer.once("close", (code) => {
          clearTimeout(fallback);
          if (code !== 0) {
            child.kill();
          }
        });
      } else {
        child.kill("SIGKILL");
      }
    };

    const fail = (error: unknown) => {
      if (finished || failure) {
        return;
      }

      failure = error;
      stop();
    };

    const append = (chunk: string) => {
      if (failure || finished) {
        return;
      }

      const text = sanitizer.write(chunk);
      outputSize += text.length;
      const accepted = text.slice(0, Math.max(0, outputLimit - output.length));
      output += accepted;
      if (accepted) {
        try {
          onOutput(accepted);
        } catch (error) {
          fail(error);
        }
      }
    };

    const readAvailable = async () => {
      const size = (await outputFile.stat()).size;

      if (size > FILE_OUTPUT_LIMIT_BYTES) {
        fail(new Error("命令输出超过 Sandbox 临时文件上限，已终止进程树。"));

        return;
      }

      while (readPosition < size && !failure) {
        const length = Math.min(buffer.length, size - readPosition);
        const read = await outputFile.read(buffer, 0, length, readPosition);
        if (read.bytesRead === 0) {
          break;
        }

        readPosition += read.bytesRead;
        append(decoder.write(buffer.subarray(0, read.bytesRead)));
      }
    };

    const pollOutput = () => {
      drain = drain.then(readAvailable).catch(fail);
    };

    const outputTimer = setInterval(pollOutput, FILE_OUTPUT_POLL_MS);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });

    const cleanup = () => {
      finished = true;
      clearInterval(outputTimer);
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", stop);
    };

    child.once("error", (error) => {
      if (finished) {
        return;
      }

      cleanup();
      reject(
        new Error(
          `无法启动命令，请检查可执行文件或 shell 路径。实际错误：${error.message}`,
        ),
      );
    });
    child.once("close", (code) => {
      if (finished) {
        return;
      }

      clearInterval(outputTimer);
      void (async () => {
        await drain;
        await readAvailable();
        append(decoder.end());
        cleanup();
        if (failure) {
          reject(failure);
        } else if (signal.aborted) {
          reject(new Error("任务已取消"));
        } else if (timedOut) {
          reject(new Error("命令超时，已终止进程树。"));
        } else {
          resolve({
            output,
            exitCode: code,
            truncated: outputSize > outputLimit,
          });
        }
      })().catch((error) => {
        cleanup();
        reject(error);
      });
    });

    try {
      onSpawnReturned?.();
      if (child.pid !== undefined) {
        onProcessStarted?.(child.pid);
      }

      if (signal.aborted) {
        stop();
      }
    } catch (error) {
      fail(error);
    }
  });
}

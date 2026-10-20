/**
 * Runtime stdio 测试 launcher 的子进程关闭适配，供真实 IPC 集成夹具复用。
 * 1. createRuntimeChildClose 在 spawn 后立即监听 error/exit/close，避免关闭入口错过提前退出。
 * 2. 关闭输入后等待 stdio close 而非仅 exit；所有调用共享一次关闭及 clean/orphaned 结果。
 * 3. 五秒无响应则终止仍在运行的测试 Node，再等两秒确认 close；缺少确认抛错，不能伪报清理成功。
 * 仅适用于以 Worker 运行任务的 Node stdio 夹具，不替代产品进程树清理或 Sandbox 隔离证明。
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

type Cleanup = "clean" | "orphaned";

export function createRuntimeChildClose(child: ChildProcessWithoutNullStreams) {
  let finished = false;
  let exited = false;
  let failed = false;
  let forced = false;
  let closing: Promise<Cleanup> | undefined;
  const completed = new Promise<Cleanup>((resolve) => {
    child.once("error", () => {
      failed = true;
    });
    child.stdin.once("error", () => {
      failed = true;
    });
    child.once("exit", () => {
      exited = true;
    });
    child.once("close", (code, signal) => {
      finished = true;
      resolve(
        code === 0 && !signal && !failed && !forced ? "clean" : "orphaned",
      );
    });
  });

  return () => {
    if (closing) {
      return closing;
    }

    if (finished) {
      closing = completed;

      return closing;
    }

    let terminate: NodeJS.Timeout;
    let deadline: NodeJS.Timeout | undefined;
    const bounded = new Promise<Cleanup>((resolve, reject) => {
      void completed.then(resolve);
      terminate = setTimeout(() => {
        // exit 后不能再向旧 PID 发信号；管道未关闭仍属于未确认清理。
        if (!exited) {
          forced = true;
          try {
            child.kill("SIGKILL");
          } catch (error) {
            reject(error);

            return;
          }
        }

        deadline = setTimeout(() => {
          reject(
            new Error("Runtime 测试子进程未确认关闭 stdio，清理状态未知。"),
          );
        }, 2_000);
      }, 5_000);
      child.stdin.end();
    });
    closing = bounded.finally(() => {
      clearTimeout(terminate);
      clearTimeout(deadline);
    });

    return closing;
  };
}

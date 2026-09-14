/**
 * `pnpm start` 的常驻父进程，监督实际承载 Fastify 的 main 子进程。
 * package.json 的 start 入口直接运行本文件；它通过 Node IPC 接收 main 的受控重载请求，
 * 再在旧进程释放端口后启动同一份构建产物，浏览器随后可重新连接。
 *
 * 1. workerPath 根据当前是 TypeScript 开发执行还是编译产物，定位同目录的 main.ts 或 main.js。
 * 2. startWorker 保留当前工作目录、环境、Node 启动参数和标准输出，fork 一个可通过 IPC 通信的后端子进程。
 * 3. 子进程仅能以固定 server.reload 事件要求替换；它正常退出时父进程退出，重载退出时父进程才创建下一代子进程。
 * 4. SIGINT 与 SIGTERM 转发给当前子进程，防止父进程在子进程尚未保存中断状态时提前离开。
 *
 * 此文件不解释或执行浏览器传来的数据；HTTP 鉴权、确认、任务中断和端口关闭全部留在 app.ts/main.ts。
 * 父进程只在收到已关闭子进程的固定 IPC 信号后重启，因此不会并行占用服务端口。
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js",
    import.meta.url,
  ),
);
let worker: ChildProcess | undefined;
let restartRequested = false;
let stopping = false;

function isReloadRequest(message: unknown) {
  return (
    typeof message === "object" &&
    message !== null &&
    "event" in message &&
    message.event === "server.reload"
  );
}

function startWorker() {
  const child = fork(workerPath, [], {
    cwd: process.cwd(),
    env: process.env,
    execArgv: process.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  worker = child;
  child.on("message", (message) => {
    if (isReloadRequest(message)) {
      restartRequested = true;
    }
  });
  child.on("exit", (code) => {
    if (restartRequested && !stopping) {
      restartRequested = false;
      startWorker();

      return;
    }

    process.exitCode = code ?? 1;
  });
}

function stopWorker(signal: NodeJS.Signals) {
  stopping = true;
  restartRequested = false;
  worker?.kill(signal);
}

startWorker();

process.on("SIGINT", () => stopWorker("SIGINT"));
process.on("SIGTERM", () => stopWorker("SIGTERM"));

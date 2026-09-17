/**
 * 统一启动 CodeAtelier 的离线测试和测试模式构建，防止测试进程继承开发机的连接配置或密钥。
 * package.json 的 test、test:watch、test:e2e 调用本脚本；它再以绝对 Node 路径启动 Vitest、Vite、TypeScript 和 Playwright。
 *
 * 1. createTestEnvironment 只构造预设的 CodeAtelier 连接、空 API key、Node、必要系统工具和标准 Git 安装路径及临时目录，不复制父进程环境。
 * 2. run 以该环境顺序启动子进程，并将输出和退出状态原样交给调用终端。
 * 3. build 完成隔离的 test mode 构建；unit/watch 分别运行 Vitest 的一次性或监听模式；e2e 复用构建后运行 Playwright。
 *
 * 脚本不加载 dotenv、不调用模型服务，也不写用户工作区；临时运行目录仅供测试进程和子进程使用。Vitest 自身不接收父进程环境，Vite test 模式另行禁用 dotenv。
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = join(projectRoot, ".local", "test-runtime");

function createTestEnvironment(): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath);
  const windowsDrive = process.execPath.slice(0, 3);
  const systemPath =
    process.platform === "win32"
      ? [
          nodeDirectory,
          `${windowsDrive}Windows\\System32`,
          `${windowsDrive}Program Files\\Git\\cmd`,
          `${windowsDrive}Program Files\\Git\\bin`,
        ].join(delimiter)
      : [nodeDirectory, "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: systemPath,
    TMPDIR: runtimeDirectory,
    TEMP: runtimeDirectory,
    TMP: runtimeDirectory,
    CODEATELIER_BASE_URL: "http://127.0.0.1:9999/v1",
    CODEATELIER_MODEL: "test-model",
    CODEATELIER_API_KEY: "",
    CODEATELIER_AUXILIARY_MODEL: "",
    CODEATELIER_AUXILIARY_REASONING_EFFORT: "",
    CODEATELIER_WEB_PASSWORD_ENABLED: "",
    CODEATELIER_WEB_PASSWORD: "",
  };

  if (process.platform === "win32") {
    environment.SystemRoot = `${windowsDrive}Windows`;
    environment.ComSpec = `${windowsDrive}Windows\\System32\\cmd.exe`;
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }

  return environment;
}

async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: createTestEnvironment(),
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            signal
              ? `${command} was terminated by ${signal}.`
              : `${command} exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

async function buildTestArtifacts() {
  await run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.server.json",
  ]);
  await run(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "build",
    "--mode",
    "test",
  ]);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);

  await mkdir(runtimeDirectory, { recursive: true });

  if (mode === "unit") {
    await run(process.execPath, [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...args,
    ]);

    return;
  }

  if (mode === "watch") {
    await run(process.execPath, ["node_modules/vitest/vitest.mjs", ...args]);

    return;
  }

  if (mode === "build") {
    await buildTestArtifacts();

    return;
  }

  if (mode === "e2e") {
    await buildTestArtifacts();
    await run(process.execPath, [
      "node_modules/@playwright/test/cli.js",
      "test",
      ...args,
    ]);

    return;
  }

  throw new Error(
    "Usage: test-runner.ts <build|unit|watch|e2e> [test arguments]",
  );
}

await main();

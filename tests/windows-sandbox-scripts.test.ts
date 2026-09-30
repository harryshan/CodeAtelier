/**
 * 验证 package.json 的 Windows Sandbox 维护入口及 run.ts 的平台分流，不执行真实 PowerShell。
 * 普通 Vitest 测试通过动态导入运行脚本；平台、argv 和 spawn 都由本文件控制，系统安装状态不变。
 *
 * 1. 保存进程字段并在 afterEach 恢复；runEntry 每次清空模块缓存，让脚本重新解析固定 action。
 * 2. pnpm 入口与 Windows action 用例核对脚本路径、固定 Mode、非 shell 启动和退出状态。
 * 3. 失败与非 Windows 用例验证错误传播、无子进程的 SKIP，以及未知或缺失 action 的拒绝。
 *
 * spawn 替身仅发出 exit/error 事件；不触发 UAC、不创建账户或修改 ACL/WFP，不能作为安装态验收。
 */

import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const scriptDirectory = fileURLToPath(
  new URL("../scripts/windows-sandbox/", import.meta.url),
);

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

async function runEntry(
  action: string | undefined,
  platform: NodeJS.Platform = "win32",
  outcome: number | null | Error = 0,
) {
  vi.resetModules();
  process.argv = [process.execPath, "run.ts", ...(action ? [action] : [])];
  process.exitCode = undefined;
  Object.defineProperty(process, "platform", { value: platform });
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => {
      if (outcome instanceof Error) {
        child.emit("error", outcome);
      } else {
        child.emit("exit", outcome);
      }
    });

    return child as never;
  });

  await import("../scripts/windows-sandbox/run.js");
}

it("provides the pnpm repair entry without changing the installer", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  expect(manifest.scripts["sandbox:repair"]).toBe(
    "tsx scripts/windows-sandbox/run.ts repair",
  );
});

it.each([
  ["build", "build-native.ps1", []],
  ["install", "install.ps1", ["-Mode", "Install"]],
  ["repair", "install.ps1", ["-Mode", "Repair"]],
  ["verify", "install.ps1", ["-Mode", "Verify"]],
  ["uninstall", "install.ps1", ["-Mode", "Uninstall"]],
  ["recover", "recover.ps1", []],
] as const)(
  "dispatches %s to fixed PowerShell arguments",
  async (action, script, args) => {
    await runEntry(action);

    expect(childProcess.spawn).toHaveBeenCalledExactlyOnceWith(
      "pwsh",
      ["-NoProfile", "-File", path.join(scriptDirectory, script), ...args],
      {
        cwd: path.resolve(scriptDirectory, "..", ".."),
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    expect(process.exitCode).toBe(0);
  },
);

it.each([7, null])("preserves the repair exit outcome %s", async (exitCode) => {
  await runEntry("repair", "win32", exitCode);

  expect(process.exitCode).toBe(exitCode ?? 1);
});

it("propagates PowerShell startup errors without reporting success", async () => {
  const failure = new Error("PowerShell unavailable");

  await expect(runEntry("repair", "win32", failure)).rejects.toBe(failure);
  expect(process.exitCode).toBeUndefined();
});

it.each(["darwin", "linux"] as const)(
  "skips repair on %s without starting PowerShell",
  async (platform) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runEntry("repair", platform);

    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      `WINDOWS_SANDBOX SKIP platform=${platform} action=repair\n`,
    );
    expect(process.exitCode).toBeUndefined();
  },
);

it.each([undefined, "unsupported"])(
  "rejects action %s before spawning a process",
  async (action) => {
    await expect(runEntry(action)).rejects.toThrow(
      "Usage: run.ts <build|install|repair|verify|uninstall|recover>",
    );
    expect(childProcess.spawn).not.toHaveBeenCalled();
  },
);

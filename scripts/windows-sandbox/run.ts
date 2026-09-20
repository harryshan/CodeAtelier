/**
 * 为 package.json 提供跨平台的 Windows Sandbox 脚本入口。
 * 默认 test/check 不调用本文件；用户显式运行 sandbox:* 时，Windows 转交现有 PowerShell 脚本，
 * macOS/Linux 只输出稳定的 SKIP 并成功退出，不探测账户、ACL、WFP、MSVC 或 PowerShell。
 *
 * 1. 解析固定 build/install/verify/uninstall/recover action，拒绝任意脚本或参数注入。
 * 2. 非 win32 不创建子进程或文件，确保 Windows 专用实现完全禁用。
 * 3. win32 使用非 shell spawn 运行固定 pwsh argv，并原样继承输出和退出码。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
const definitions: Record<string, { script: string; args: string[] }> = {
  build: { script: "build-native.ps1", args: [] },
  install: { script: "install.ps1", args: ["-Mode", "Install"] },
  verify: { script: "install.ps1", args: ["-Mode", "Verify"] },
  uninstall: { script: "install.ps1", args: ["-Mode", "Uninstall"] },
  recover: { script: "recover.ps1", args: [] },
};
const definition = action ? definitions[action] : undefined;
if (!definition) {
  throw new Error("Usage: run.ts <build|install|verify|uninstall|recover>");
}

if (process.platform !== "win32") {
  process.stdout.write(
    `WINDOWS_SANDBOX SKIP platform=${process.platform} action=${action}\n`,
  );
} else {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(directory, definition.script);
  const child = spawn(
    "pwsh",
    ["-NoProfile", "-File", script, ...definition.args],
    {
      cwd: path.join(directory, "..", ".."),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

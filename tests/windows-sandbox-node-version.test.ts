/**
 * 验证 Windows Sandbox 安装器对 Node 24/26 的选择与版本拒绝行为，由普通 Vitest 套件执行。
 * 仅提取安装器的版本和源文件检查函数，在系统 PowerShell 中加载，不执行顶层维护操作。
 *
 * 1. 临时转发脚本模拟版本管理器 shim，实际调用 Node，必须返回真实解释器而非转发文件。
 * 2. 版本夹具独立调用 Assert-RuntimeNodeVersion，覆盖受支持、不受支持及失败探测；不把版本号视为完整解释器证明。
 * 3. finally 删除本测试的临时文件；不创建账户、不修改 ProgramData、ACL 或 WFP，非 Windows 跳过。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);

it.skipIf(process.platform !== "win32")(
  "resolves a version-manager shim to the standalone Node executable",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runtime-node-shim-"));
    try {
      const installer = await readFile(
        new URL("../scripts/windows-sandbox/install.ps1", import.meta.url),
        "utf8",
      );
      const functions = [
        "Assert-RegularSourceFile",
        "Assert-RuntimeNodeVersion",
        "Resolve-RuntimeNode",
      ].map((name) => {
        const match = installer.match(
          new RegExp(`function ${name} \\{[\\s\\S]*?^\\}`, "m"),
        );
        expect(match).not.toBeNull();

        return match![0];
      });
      const shim = path.join(directory, "node.cmd");
      await writeFile(shim, `@echo off\r\n"${process.execPath}" %*\r\n`);
      const probe = path.join(directory, "probe.ps1");
      await writeFile(
        probe,
        [
          "param([string]$RuntimeNodePath)",
          "$ErrorActionPreference = 'Stop'",
          ...functions,
          "Resolve-RuntimeNode",
        ].join("\n"),
      );
      const { stdout } = await execute(
        powershell,
        ["-NoProfile", "-File", probe, shim],
        {
          windowsHide: true,
          timeout: 10000,
        },
      );
      expect(stdout.trim().toLowerCase()).toBe(process.execPath.toLowerCase());

      const direct = await execute(
        powershell,
        ["-NoProfile", "-File", probe, process.execPath],
        {
          windowsHide: true,
          timeout: 10000,
        },
      );
      expect(direct.stdout.trim().toLowerCase()).toBe(
        process.execPath.toLowerCase(),
      );

      // A version string alone must never admit a wrapper into the installation.
      for (const reported of ["relative-node.exe", "node.cmd", ""]) {
        await writeFile(
          shim,
          `@echo off\r\nif "%~1"=="--version" (echo v26.10.0) else (${reported ? `echo ${reported}` : "exit /b 2"})\r\n`,
        );
        await expect(
          execute(powershell, ["-NoProfile", "-File", probe, shim], {
            windowsHide: true,
            timeout: 10000,
          }),
        ).rejects.toMatchObject({ code: 1 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "accepts Node 24/26 and rejects unsupported versions and failed probes",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runtime-node-"));
    const installer = fileURLToPath(
      new URL("../scripts/windows-sandbox/install.ps1", import.meta.url),
    );
    const cases = [
      { version: "v24.0.0", exitCode: 0, accepted: true },
      { version: "v26.10.0", exitCode: 0, accepted: true },
      { version: "v22.0.0", exitCode: 0, accepted: false },
      { version: "v25.0.0", exitCode: 0, accepted: false },
      { version: "v27.0.0", exitCode: 0, accepted: false },
      { version: "invalid", exitCode: 0, accepted: false },
      { version: "v26.10.0", exitCode: 1, accepted: false },
    ];

    try {
      for (const [index, candidate] of cases.entries()) {
        await writeFile(
          path.join(directory, `node-${index}.cmd`),
          `@echo off\r\nif not "%~1"=="--version" exit /b 2\r\necho ${candidate.version}\r\nexit /b ${candidate.exitCode}\r\n`,
        );
      }

      const probe = path.join(directory, "probe.ps1");
      await writeFile(
        probe,
        `param([string]$Installer, [string]$Directory, [int]$Count)
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -gt 0) { throw 'Installer syntax is invalid' }
$Functions = $Ast.FindAll({ param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $Node.Name -in @('Assert-RegularSourceFile', 'Assert-RuntimeNodeVersion', 'Resolve-RuntimeNode')
}, $false)
foreach ($Function in $Functions) {
    . ([scriptblock]::Create($Function.Extent.Text))
}
$Results = @(for ($Index = 0; $Index -lt $Count; $Index++) {
    $RuntimeNodePath = Join-Path $Directory "node-$Index.cmd"
    try {
        $Version = & $RuntimeNodePath --version
        Assert-RuntimeNodeVersion -Version $Version -ExitCode $LASTEXITCODE
        @{ accepted = $true }
    } catch {
        @{ accepted = $false; error = $_.Exception.Message }
    }
})
ConvertTo-Json -InputObject $Results -Compress
`,
      );
      const { stdout } = await execute(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          probe,
          installer,
          directory,
          String(cases.length),
        ],
        { windowsHide: true, timeout: 10000 },
      );
      const results = JSON.parse(stdout) as {
        accepted: boolean;
        error?: string;
      }[];

      expect(results.map((result) => result.accepted)).toEqual(
        cases.map((candidate) => candidate.accepted),
      );
      for (const result of results) {
        if (!result.accepted) {
          expect(result.error).toContain("Node.js 24");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

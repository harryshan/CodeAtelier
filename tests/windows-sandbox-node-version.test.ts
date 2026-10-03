/**
 * 验证 Windows Sandbox 安装器对 Node 24/26 的选择与版本拒绝行为，由普通 Vitest 套件执行。
 * 使用 Windows PowerShell 的 AST 只加载安装器的版本和源文件检查函数，不执行安装器顶层维护操作。
 *
 * 1. 在临时目录创建只响应 --version 的命令夹具，模拟受支持、不受支持及失败的 Node executable。
 * 2. 真实 PowerShell 调用 Resolve-RuntimeNode，核对成功返回文件路径，失败保留明确拒绝结果。
 * 3. finally 删除本测试的临时文件；不创建账户、不修改 ProgramData、ACL 或 WFP，非 Windows 跳过。
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

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
        $Resolved = Resolve-RuntimeNode
        @{ accepted = $true; path = $Resolved }
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
        path?: string;
        error?: string;
      }[];

      expect(results.map((result) => result.accepted)).toEqual(
        cases.map((candidate) => candidate.accepted),
      );
      for (const [index, result] of results.entries()) {
        if (result.accepted) {
          expect(result.path).toBe(path.join(directory, `node-${index}.cmd`));
        } else {
          expect(result.error).toContain("Node.js 24");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

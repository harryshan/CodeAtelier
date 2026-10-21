/**
 * SettingsStore 的私有文件 I/O：只操作宿主显式数据目录，不读工作区配置。
 * 1. readSettingsText 拒绝链接、非普通文件和超大文件；verifyPrivateSettings 单独核验私有权限。
 * 2. protectWindowsFile 固定使用 Windows PowerShell 自带模块，在写入任何秘密前设置并验证当前用户/SYSTEM 专用 DACL。
 * 3. writePrivateSettings 限制大小，用独占临时文件、flush、发布前校验与 rename 写入完整内容。
 * 4. SettingsFileConflict 保留上层并发冲突类型，其他写失败仅返回固定安全消息；此模块不发布内存状态。
 * Windows 不以 chmod 代替 ACL；同宿主用户仍有读写权，文件不是加密保险库。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export class SettingsFileConflict extends Error {}

export function readSettingsText(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }

  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 1024 * 1024
  ) {
    throw new Error("设置必须是小于 1 MiB 的独立普通文件。");
  }

  return readFileSync(file, "utf8");
}

function protectWindowsFile(file: string, verifyOnly: boolean) {
  const script = `
$ErrorActionPreference = 'Stop'
# PowerShell 7 启动的 Node 会继承其模块路径，5.1 自动加载同名安全模块时会失败。
# 仅在此 ACL 子进程使用自身系统模块，不修改终端或产品命令的环境。
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$p = $env:CODEATELIER_PRIVATE_SETTINGS_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($env:CODEATELIER_PRIVATE_SETTINGS_VERIFY -ne 'true') {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($sid, $system)) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
  }
  Set-Acl -LiteralPath $p -AclObject $acl
}
$actual = Get-Acl -LiteralPath $p
if (!$actual.AreAccessRulesProtected) { throw 'Unprotected settings ACL' }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference -ne $sid -and $rule.IdentityReference -ne $system) {
    throw 'Unexpected settings reader'
  }
}
`;
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CODEATELIER_PRIVATE_SETTINGS_FILE: file,
        CODEATELIER_PRIVATE_SETTINGS_VERIFY: String(verifyOnly),
      },
    });
  } catch {
    throw new Error(
      "无法设置或验证 settings.json 私有 Windows ACL；拒绝读取或写入凭据。",
    );
  }
}

export function verifyPrivateSettings(file: string) {
  if (process.platform === "win32") {
    protectWindowsFile(file, true);
  } else if ((lstatSync(file).mode & 0o077) !== 0) {
    throw new Error("settings.json 必须仅允许当前用户访问（0600）。");
  }
}

export function writePrivateSettings(
  file: string,
  text: string,
  beforePublish?: () => void,
) {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("设置文件超过 1 MiB，拒绝写入无法重新加载的配置。");
  }

  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  let closed = false;
  try {
    if (process.platform === "win32") {
      protectWindowsFile(temporary, false);
    }

    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    beforePublish?.();
    renameSync(temporary, file);
  } catch (error) {
    if (error instanceof SettingsFileConflict) {
      throw error;
    }

    throw new Error(
      "设置文件未能安全保存；请重新读取确认磁盘状态，不要重复覆盖。",
    );
  } finally {
    if (!closed) {
      closeSync(descriptor);
    }

    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

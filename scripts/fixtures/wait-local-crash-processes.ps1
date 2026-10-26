# 真实服务崩溃验收的只读进程退出探针，由 verify-local-server-crash 调用。
# 1. 接收本夹具已观察到的 Runtime/命令 PID，先获取有限查询/SYNCHRONIZE 句柄并记录创建时间。
#    专用账户进程 ACL 拒绝时只读查询 CIM PID/创建时间；明确记录不同证据，不提升权限。
# 2. 句柄/身份在终止服务之前采集；ready 后等待具体句柄或原 CIM 身份消失，避免仅凭 PID 判定。
# 3. 全局 45 秒超时或任一 API 失败均非零退出；finally 关闭句柄，不终止进程、不修改权限/文件。
# 仅证明已绑定的两个进程身份退出，不把它当成任意后代或完整 Job 的独立证明。
param([Parameter(Mandatory = $true)][string]$ProcessIds)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LocalCrashProbe {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
$handles = @()
$identities = @()
$cimIdentities = @()
try {
    foreach ($processId in ($ProcessIds -split ',')) {
        $handle = [LocalCrashProbe]::OpenProcess(0x00101000, $false, [uint32]$processId)
        if ($handle -eq [IntPtr]::Zero) {
            $failure = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($failure -ne 5) {
                throw "OpenProcess failed: $failure"
            }
            $observed = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
            if (-not $observed -or -not $observed.CreationDate) {
                throw 'Cannot bind live CIM process identity'
            }
            $identity = @{ pid = [int]$processId; created = $observed.CreationDate.ToUniversalTime().ToString('o'); method = 'cim-creation-identity'; handleDenied = $true }
            $identities += $identity
            $cimIdentities += $identity
            continue
        }
        $handles += $handle
        [long]$created = 0
        [long]$exited = 0
        [long]$kernel = 0
        [long]$user = 0
        if (-not [LocalCrashProbe]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) {
            throw 'GetProcessTimes failed'
        }
        if ([LocalCrashProbe]::WaitForSingleObject($handle, 0) -ne 258) {
            throw 'Process exited before crash'
        }
        $identities += @{ pid = [int]$processId; created = "$created"; method = 'process-handle' }
    }
    @{ state = 'ready'; identities = $identities } | ConvertTo-Json -Compress
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    foreach ($handle in $handles) {
        $remaining = [Math]::Max(0, 45000 - $elapsed.ElapsedMilliseconds)
        if ([LocalCrashProbe]::WaitForSingleObject($handle, [uint32]$remaining) -ne 0) {
            throw 'Known process did not exit within crash deadline'
        }
    }
    foreach ($identity in $cimIdentities) {
        while ($true) {
            $observed = Get-CimInstance Win32_Process -Filter "ProcessId = $($identity.pid)"
            if (-not $observed) {
                break
            }
            if (-not $observed.CreationDate) {
                throw 'CIM creation identity became unavailable'
            }
            if ($observed.CreationDate.ToUniversalTime().ToString('o') -ne $identity.created) {
                break
            }
            if ($elapsed.ElapsedMilliseconds -ge 45000) {
                throw 'Known CIM process did not exit within crash deadline'
            }
            Start-Sleep -Milliseconds 100
        }
    }
    @{ state = 'exited'; elapsedMs = $elapsed.ElapsedMilliseconds } | ConvertTo-Json -Compress
} finally {
    foreach ($handle in $handles) {
        [void][LocalCrashProbe]::CloseHandle($handle)
    }
}

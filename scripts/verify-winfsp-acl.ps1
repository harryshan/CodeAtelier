# 在 verify-winfsp-overlay 创建的独占夹具上验证真实 Windows ACL、共享锁及映射写入。
# 1. 只操作传入挂载的固定测试文件；比较来源根与文件的 DACL，绝不修改来源权限。
# 2. 验证拒绝 ACE、受保护 DACL、根继承变化/撤销及 owner/group 保留。
# 3. 验证独占打开与内存映射写入；最终恢复测试对象 ACL，失败时保留现场并抛错。
# 此脚本不安装驱动、不修改 Sandbox，不属于默认 test/check。
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$Source)

$ErrorActionPreference = 'Stop'
if (-not $Workspace.StartsWith('\\CodeAtelier\')) { throw 'Expected a managed test volume' }
$SourceAcl = (Get-Acl -LiteralPath $Source).Sddl
$SourceFileAcl = (Get-Acl -LiteralPath (Join-Path $Source 'acl.txt')).Sddl
$Target = Join-Path $Workspace 'acl.txt'
$Original = Get-Acl -LiteralPath $Target
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$Acl = Get-Acl -LiteralPath $Target
$Acl.SetAccessRuleProtection($true, $true)
$Deny = [Security.AccessControl.FileSystemAccessRule]::new($Sid, 'WriteData', 'Deny')
$Acl.AddAccessRule($Deny)
[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Target), $Acl)
try {
    $Denied = $false
    try { [IO.File]::WriteAllText($Target, 'must not write') }
    catch [UnauthorizedAccessException] { $Denied = $true }
    if (-not $Denied) { throw 'Deny ACE did not block write' }
    $Observed = Get-Acl -LiteralPath $Target
    if (-not $Observed.AreAccessRulesProtected -or $Observed.Owner -ne $Original.Owner -or $Observed.Group -ne $Original.Group) { throw 'ACL owner/group/protection mismatch' }
} finally {
    $Restored = Get-Acl -LiteralPath $Target
    $Restored.SetSecurityDescriptorSddlForm($Original.Sddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Target), $Restored)
}

$RootAcl = Get-Acl -LiteralPath $Workspace
$ProbeSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-10001-10002-10003-10004')
$Rule = [Security.AccessControl.FileSystemAccessRule]::new($ProbeSid, 'Read', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$Modified = Get-Acl -LiteralPath $Workspace
$Modified.AddAccessRule($Rule)
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Workspace), $Modified)
try {
    $Inherited = (Get-Acl -LiteralPath (Join-Path $Workspace 'folder\nested.txt')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if (-not ($Inherited | Where-Object { $_.IdentityReference -eq $ProbeSid -and $_.IsInherited })) { throw 'Root ACE was not inherited by lower descendant' }
} finally {
    $Restored = Get-Acl -LiteralPath $Workspace
    $Restored.SetSecurityDescriptorSddlForm($RootAcl.Sddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Workspace), $Restored)
}
$After = (Get-Acl -LiteralPath (Join-Path $Workspace 'folder\nested.txt')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($After | Where-Object { $_.IdentityReference -eq $ProbeSid }) { throw 'Revoked root ACE remained on a child' }

$Locked = [IO.File]::Open($Target, 'Open', 'ReadWrite', 'None')
try {
    $Denied = $false
    try {
        $Other = [IO.File]::OpenRead($Target)
        $Other.Dispose()
    } catch [IO.IOException] { $Denied = $true }
    if (-not $Denied) { throw 'Exclusive file sharing was not enforced' }
} finally { $Locked.Dispose() }

$Mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($Target, [IO.FileMode]::Open)
try {
    $View = $Mapping.CreateViewAccessor()
    try { $View.Write(0,[byte]90); $View.Flush() }
    finally { $View.Dispose() }
} finally { $Mapping.Dispose() }
if ([IO.File]::ReadAllBytes($Target)[0] -ne 90 -or [IO.File]::ReadAllBytes((Join-Path $Source 'acl.txt'))[0] -ne 65) { throw 'Mapped write did not stay private' }
if ((Get-Acl -LiteralPath $Source).Sddl -ne $SourceAcl -or (Get-Acl -LiteralPath (Join-Path $Source 'acl.txt')).Sddl -ne $SourceFileAcl) { throw 'Source ACL changed' }
Write-Output 'OVERLAY_ACL_LOCK_MAPPING PASS'

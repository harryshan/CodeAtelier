<#
为已停止写入的 CodeAtelier 取得不可变 raw 备份，不通过 SMB 打开 SQLite。
1. 校验物理源路径和全新目标，继承源 DACL，枚举主库及 WAL/SHM。
2. 先为全部文件取得 Read + ShareRead 句柄，拒绝任一写入/删除共享冲突；持有到所有副本与摘要完成。
3. 每份文件 Flush(true) 后核对 SHA256，记录无正文清单；最后检查文件集合没有改变。
4. 任一失败保留副本以供审计，不删除 WAL、不修复、不移动原件；后续 snapshot 命令只恢复副本。
MSIX 环境应显式使用 \\localhost\C$\Users\... 作为 SourceDirectory；Destination 必须为本地非 AppData 路径。
#>
param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][switch]$WritersStopped
)
$ErrorActionPreference = 'Stop'
if (-not $WritersStopped) {
  throw '必须停止全部写入者。'
}
$sourceRoot = [IO.Path]::GetFullPath($SourceDirectory)
$destinationRoot = [IO.Path]::GetFullPath($Destination)
if ($sourceRoot -eq $destinationRoot -or (Test-Path -LiteralPath $destinationRoot)) {
  throw '目标必须是独立、尚不存在的本地目录。'
}
if ($destinationRoot.StartsWith('\\') -or $destinationRoot -match '\\AppData\\') {
  throw '目标须位于本地非 AppData 路径。'
}
$files = @(Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Name -match '^history(-\d{6})?\.sqlite(-wal|-shm)?$' } | Sort-Object Name)
if (-not ($files.Name -contains 'history.sqlite')) {
  throw '没有找到首个真实分片。'
}
$streams = [Collections.Generic.List[IO.FileStream]]::new()
try {
  foreach ($file in $files) {
    $streams.Add([IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
  }
  [IO.Directory]::CreateDirectory($destinationRoot) | Out-Null
  $sourceAcl = Get-Acl -LiteralPath $sourceRoot
  Set-Acl -LiteralPath $destinationRoot -AclObject $sourceAcl
  $manifest = @()
  for ($index = 0; $index -lt $files.Count; $index++) {
    $targetFile = Join-Path $destinationRoot $files[$index].Name
    $output = [IO.File]::Open($targetFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $streams[$index].CopyTo($output)
      $output.Flush($true)
    } finally {
      $output.Dispose()
    }

    Set-Acl -LiteralPath $targetFile -AclObject (Get-Acl -LiteralPath $files[$index].FullName)
    $streams[$index].Position = 0
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = [Convert]::ToHexString($hash.ComputeHash($streams[$index])).ToLowerInvariant()
    } finally {
      $hash.Dispose()
    }

    $copyHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copyHash -ne $digest) {
      throw '备份摘要不一致。'
    }

    $manifest += @{
      name = $files[$index].Name
      bytes = $streams[$index].Length
      sha256 = $digest
    }
  }
  $currentNames = @(Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Name -match '^history(-\d{6})?\.sqlite(-wal|-shm)?$' } | Sort-Object Name | Select-Object -ExpandProperty Name)
  if (($currentNames -join '|') -ne ($files.Name -join '|')) {
    throw '冻结期间文件集合变化。'
  }

  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destinationRoot 'source-manifest.json') -Encoding utf8
  Write-Output "冻结完成：$($files.Count) 个文件，SHA256 全部一致。"
} finally {
  foreach ($stream in $streams) {
    $stream.Dispose()
  }
}

# 测量人工 PoC 的独立实际目录，供 verify-virtual-worktree.ts 调用。
# 1. JSON 输入列出自己的 control/admin 或普通 checkout；不枚举虚拟卷或来源 Git common。
# 2. C# 读取 FILE_STANDARD_INFO 的实际 AllocationSize，并累计逻辑长度和文件数。
# 3. 拒绝重解析条目，保留失败；只读，不修复 ACL 或清理文件。
# 结果不包含 NTFS MFT/目录索引/日志开销，不能称为整个卷的空间增量。
param([Parameter(Mandatory)][string]$InputFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WorktreeDisk {
    [StructLayout(LayoutKind.Sequential)]
    struct StandardInfo {
        public long AllocationSize;
        public long EndOfFile;
        public uint Links;
        public byte DeletePending;
        public byte Directory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass,
        out StandardInfo info, uint size);
    public sealed class Result {
        public long files;
        public long logicalBytes;
        public long allocatedBytes;
    }
    static void Visit(string root, Result result) {
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) {
            throw new IOException("Refusing disk accounting through a reparse point");
        }
        foreach (string file in System.IO.Directory.EnumerateFiles(root)) {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) {
                throw new IOException("Unexpected reparse file");
            }
            using (SafeFileHandle handle = CreateFile(file, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
                StandardInfo info;
                if (handle.IsInvalid || !GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo)))) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                result.files++;
                result.logicalBytes += info.EndOfFile;
                result.allocatedBytes += info.AllocationSize;
            }
        }
        foreach (string directory in System.IO.Directory.EnumerateDirectories(root)) {
            Visit(directory, result);
        }
    }
    public static Result Measure(string[] roots) {
        Result result = new Result();
        foreach (string root in roots) { Visit(root, result); }
        return result;
    }
}
'@
$Paths = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
[WorktreeDisk]::Measure([string[]]$Paths) | ConvertTo-Json -Compress

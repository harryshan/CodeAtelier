// 附加到固定校验过的 Riftri storage crate，供 CodeAtelier snapshot helper 使用。
// 1. clone_snapshot_file 调用 Linux/macOS 原生单文件 CoW，不进行字节复制 fallback。
// 2. 保留来源普通 rwx 权限（不复制 setuid/setgid）；不设置来源权限或共享文件 inode。
// 3. macOS 带 ACL 的文件保守拒绝；失败由调用方保留未发布目录。
pub fn clone_snapshot_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), StorageError> {
    #[cfg(target_os = "linux")]
    reflink::clone_file(source, destination, None)?;
    #[cfg(target_os = "macos")]
    {
        if has_macos_acl(source)? {
            return Err(StorageError::UnsupportedEntry(source.to_path_buf()));
        }
        apfs::clone_file(source, destination, None)?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(StorageError::UnsupportedPlatform {
        backend: "CodeAtelier snapshot clone",
    });
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let set_mode = || -> std::io::Result<()> {
            let mode = std::fs::symlink_metadata(source)?.permissions().mode() & 0o777;
            std::fs::set_permissions(destination, std::fs::Permissions::from_mode(mode))
        };
        set_mode().map_err(|source| StorageError::Io {
            operation: "set snapshot mode",
            path: destination.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

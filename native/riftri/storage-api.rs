// 附加到固定、校验过的 Riftri storage crate 的窄 API，由 build-riftri.ts 使用。
// 只公开已有的单文件原生克隆；不使用 tree/base lifecycle，也不加入字节复制 fallback。
// 最后按 Git mode 和当前 umask 设置新文件权限，绝不修改 source。
pub fn clone_checkout_file(
    source: &std::path::Path,
    destination: &std::path::Path,
    executable: bool,
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
        backend: "CodeAtelier checkout clone",
    });
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let set_mode = || -> std::io::Result<()> {
            let mask = current_umask()?;
            let mode = if executable { 0o777 } else { 0o666 };
            std::fs::set_permissions(destination, std::fs::Permissions::from_mode(mode & !mask))
        };
        set_mode().map_err(|source| StorageError::Io {
            operation: "set checkout mode",
            path: destination.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

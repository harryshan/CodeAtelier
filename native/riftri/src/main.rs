//! CodeAtelier 的 Riftri 当前目录快照 helper；供宿主 WorktreeService 调用。
//! 1. probe 返回 v2 原生能力；snapshot 从可变主目录创建私有 CoW 文件树。
//! 2. copy_tree 保留文件字节、执行位、符号链接及独立 Git metadata，不运行 Git、不计算内容 hash。
//! 3. check_entry 拒绝外置 Git、特殊文件和活跃 Git 锁；.git/worktrees 不复制。
//! 4. 每条目复制前后核对身份/时间/大小，发现变化停止；这不是全目录原子快照。
//! 5. main 只返回有界计数/错误；失败目录保留，不修改来源、不重放或 fallback。

use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};

fn backend(directory: &Path) -> Option<&'static str> {
    #[cfg(target_os = "linux")]
    if riftri_storage::ReflinkCloner::probe(directory).status
        == riftri_storage::CapabilityStatus::Supported
    {
        return Some("riftri-reflink");
    }
    #[cfg(target_os = "macos")]
    if riftri_storage::probe_backends(directory)
        .iter()
        .any(|capability| {
            capability.kind == riftri_storage::BackendKind::ApfsClone
                && capability.status == riftri_storage::CapabilityStatus::Supported
        })
    {
        return Some("riftri-apfs");
    }
    let _ = directory;
    None
}

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.mode() == after.mode()
            && before.size() == after.size()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        let _ = (before, after);
        false
    }
}

fn check_entry(relative: &Path, metadata: &Metadata) -> io::Result<()> {
    let in_git = relative.starts_with(".git");
    if relative.file_name().is_some_and(|name| name == ".git")
        && (relative != Path::new(".git") || !metadata.is_dir() || metadata.is_symlink())
    {
        return Err(io::Error::other(
            "external or nested Git metadata is unsupported; use Git worktree",
        ));
    }
    if in_git
        && (metadata.is_symlink()
            || relative
                .extension()
                .is_some_and(|extension| extension == "lock")
            || relative == Path::new(".git/commondir")
            || relative == Path::new(".git/objects/info/alternates"))
    {
        return Err(io::Error::other(
            "Git metadata is busy or redirects outside the snapshot",
        ));
    }
    Ok(())
}

// Preserve internal relative links, remap internal absolute links, reject escaping links.
// A copied link must never route an agent write back into the source checkout.
fn link_target(source: &Path, destination: &Path, relative: &Path) -> io::Result<PathBuf> {
    let target = fs::read_link(source.join(relative))?;
    let joined = if target.is_absolute() {
        target.clone()
    } else {
        source.join(relative).parent().unwrap().join(&target)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(component),
        }
    }
    if !normalized.starts_with(source) {
        return Err(io::Error::other("external symlink is unsupported"));
    }
    // Resolve existing chains too: an internal link may itself point outside.
    match fs::canonicalize(&normalized) {
        Ok(resolved) if !resolved.starts_with(source) => {
            return Err(io::Error::other("external symlink chain is unsupported"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(if target.is_absolute() {
        destination.join(normalized.strip_prefix(source).unwrap())
    } else {
        target
    })
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    relative: &Path,
    count: &mut usize,
) -> io::Result<()> {
    let from = source.join(relative);
    let to = destination.join(relative);
    let before = fs::symlink_metadata(&from)?;
    check_entry(relative, &before)?;
    if before.is_dir() {
        fs::create_dir(&to)?;
        for entry in fs::read_dir(&from)? {
            let child = relative.join(entry?.file_name());
            if child != Path::new(".git/worktrees") {
                copy_tree(source, destination, &child, count)?;
            }
        }
    } else if before.is_file() {
        riftri_storage::clone_snapshot_file(&from, &to)
            .map_err(|_| io::Error::other("native clone failed"))?;
        *count += 1;
    } else if before.is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(link_target(source, destination, relative)?, &to)?;
        #[cfg(not(unix))]
        return Err(io::Error::other("unsupported platform"));
    } else {
        return Err(io::Error::other("special file is unsupported"));
    }
    if !unchanged(&before, &fs::symlink_metadata(&from)?) {
        return Err(io::Error::other("source changed while creating snapshot"));
    }
    Ok(())
}

fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    match args.get(1).and_then(|arg| arg.to_str()) {
        Some("probe") if args.len() == 3 => {
            println!(
                "{}",
                serde_json::json!({"version": 2, "backend": backend(Path::new(&args[2]))})
            );
        }
        Some("snapshot") if args.len() == 4 => {
            let source = fs::canonicalize(&args[2])?;
            let destination = Path::new(&args[3]);
            if !destination.is_absolute()
                || destination.starts_with(&source)
                || source.starts_with(destination)
            {
                return Err(io::Error::other("overlapping snapshot roots"));
            }
            let mut count = 0;
            copy_tree(&source, destination, Path::new(""), &mut count)?;
            println!(
                "{}",
                serde_json::json!({"version": 2, "clonedFiles": count})
            );
        }
        _ => return Err(io::Error::other("invalid command")),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        // Translate only our fixed errors into public codes, never return paths or file contents.
        let message = error.to_string();
        let code = if message.contains("Git metadata") {
            "git-layout-or-lock"
        } else if message.contains("external symlink") {
            "external-link"
        } else if message.contains("source changed") {
            "source-changed"
        } else if message.contains("native clone") {
            "native-clone"
        } else if message.contains("special file") {
            "unsupported-entry"
        } else {
            "filesystem"
        };
        println!("{}", serde_json::json!({"version": 2, "error": code}));
        std::process::exit(1);
    }
}

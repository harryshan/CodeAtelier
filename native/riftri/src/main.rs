//! CodeAtelier 可选宿主 helper：复用 Riftri 原生 clone，不创建 immutable base。
//! 1. probe 只调用目的卷的原生能力探测；populate 读取新 worktree 的 Git index 和 cached attributes。
//! 2. clone_entry 从原 checkout 克隆普通文件，以 Git blob 哈希验证私有副本；内容不符即删除副本。
//! 3. populate 只为未克隆的 index 条目调用 checkout-index，保留 Git 的过滤器/符号链接语义。
//! 4. main 只输出有界协议收据。错误由 Broker 保留现场；不删除工作区、不重试、不更改来源权限。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path};
use std::process::{Command, Stdio};

use sha1::Digest;

fn git(directory: &Path, args: &[&str], input: &[u8]) -> io::Result<Vec<u8>> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let bytes = input.to_vec();
    // Read output concurrently so a large index cannot deadlock either pipe.
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let output = child.wait_with_output()?;
    writer
        .join()
        .map_err(|_| io::Error::other("git input failed"))??;
    if !output.status.success() {
        return Err(io::Error::other("git failed"));
    }
    Ok(output.stdout)
}

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

fn blob_hash(path: &Path, expected: &str) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let header = format!("blob {}\0", file.metadata()?.len());
    let mut sha1 = sha1::Sha1::new();
    let mut sha256 = sha2::Sha256::new();
    sha1.update(header.as_bytes());
    sha256.update(header.as_bytes());
    let mut buffer = [0_u8; 65536];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        if expected.len() == 40 {
            sha1.update(&buffer[..length]);
        } else {
            sha256.update(&buffer[..length]);
        }
    }
    let actual = if expected.len() == 40 {
        format!("{:x}", sha1.finalize())
    } else {
        format!("{:x}", sha256.finalize())
    };
    Ok(actual == expected)
}

fn clone_entry(
    source: &Path,
    destination: &Path,
    name: &str,
    oid: &str,
    mode: &str,
) -> io::Result<bool> {
    let relative = Path::new(name);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || relative.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(".git"))
        })
    {
        return Err(io::Error::other("invalid index path"));
    }
    let from = source.join(relative);
    let to = destination.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&from) else {
        return Ok(false);
    };
    // Never import symlinks, special files, outside paths or their permissions.
    if !metadata.is_file() || !fs::canonicalize(&from)?.starts_with(source) {
        return Ok(false);
    }
    fs::create_dir_all(to.parent().unwrap())?;
    if riftri_storage::clone_checkout_file(&from, &to, mode == "100755").is_err() {
        // This destination is private, new and has not been exposed to an agent.
        match fs::remove_file(&to) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        return Ok(false);
    }
    if !blob_hash(&to, oid)? {
        fs::remove_file(&to)?;
        return Ok(false);
    }
    Ok(true)
}

fn populate(source: &Path, destination: &Path) -> io::Result<usize> {
    let source = fs::canonicalize(source)?;
    let index = git(destination, &["ls-files", "--stage", "-z"], &[])?;
    let Ok(text) = std::str::from_utf8(&index) else {
        // Git handles native byte paths. No clones have been created yet.
        git(destination, &["read-tree", "--reset", "-u", "HEAD"], &[])?;
        return Ok(0);
    };
    let mut entries = Vec::new();
    let mut names = Vec::new();
    for entry in text.split('\0').filter(|entry| !entry.is_empty()) {
        let (metadata, name) = entry
            .split_once('\t')
            .ok_or_else(|| io::Error::other("invalid index"))?;
        let fields: Vec<_> = metadata.split(' ').collect();
        if fields.len() != 3 || fields[2] != "0" {
            return Err(io::Error::other("unmerged index"));
        }
        entries.push((fields[0], fields[1], name));
        names.extend_from_slice(name.as_bytes());
        names.push(0);
    }
    let attributes = git(
        destination,
        &["check-attr", "--cached", "--all", "-z", "--stdin"],
        &names,
    )?;
    let fields: Vec<_> = attributes.split(|byte| *byte == 0).collect();
    let attributed: std::collections::HashSet<_> =
        fields.chunks_exact(3).map(|chunk| chunk[0]).collect();
    let config = git(destination, &["config", "--null", "--list"], &[])?;
    let transform_all = config.split(|byte| *byte == 0).any(|entry| {
        entry == b"core.autocrlf"
            || (entry.starts_with(b"core.autocrlf\n") && entry != b"core.autocrlf\nfalse")
    });
    let mut skipped = Vec::new();
    let mut cloned = 0;
    for (mode, oid, name) in entries {
        if mode == "160000" {
            // worktree add without recurse creates an empty submodule directory.
            fs::create_dir_all(destination.join(name))?;
            continue;
        }
        if !transform_all
            && !attributed.contains(name.as_bytes())
            && matches!(mode, "100644" | "100755")
            && clone_entry(&source, destination, name, oid, mode)?
        {
            cloned += 1;
        } else {
            skipped.extend_from_slice(name.as_bytes());
            skipped.push(0);
        }
    }
    if !skipped.is_empty() {
        git(destination, &["checkout-index", "--stdin", "-z"], &skipped)?;
    }
    Ok(cloned)
}

fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    match args.get(1).and_then(|arg| arg.to_str()) {
        Some("probe") if args.len() == 3 => {
            println!(
                "{}",
                serde_json::json!({"version": 1, "backend": backend(Path::new(&args[2]))})
            );
        }
        Some("populate") if args.len() == 4 => {
            let count = populate(Path::new(&args[2]), Path::new(&args[3]))?;
            println!(
                "{}",
                serde_json::json!({"version": 1, "clonedFiles": count})
            );
        }
        _ => return Err(io::Error::other("invalid command")),
    }
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("Riftri helper failed; preserve the unpublished checkout for inspection.");
        std::process::exit(1);
    }
}

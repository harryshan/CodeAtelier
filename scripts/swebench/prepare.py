# 将已构建的后端打包，供手动评测时安装到容器。
# 生成 tar.gz 和配套 JSON，后者记录文件清单及 SHA256。
#
# 1. prepare 确认评测入口已构建，收集 package.json、锁文件和后端 JavaScript。
# 2. 拒绝符号链接和仓库外文件，计算哈希，再按仓库相对路径写入压缩包。
# 3. 保存整包哈希和文件清单；命令行入口读取 root、output 并打印结果路径。
#
# 不会启动编译或评测，也不打包 .env、Git 数据、会话历史、源码映射或测试。

"""Package only built runtime files and dependency manifests for SWE-bench."""

import argparse
import hashlib
import json
import tarfile
from pathlib import Path


def prepare(root: Path, output: Path) -> dict:
    root = root.resolve()
    runtime = root / "dist/server"
    if not (runtime / "evaluation/main.js").is_file():
        raise ValueError("Run pnpm exec tsc -p tsconfig.server.json first")

    files = [root / "package.json", root / "pnpm-lock.yaml"]
    files.extend(sorted(runtime.rglob("*.js")))
    manifest = {}
    for file in files:
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise ValueError("Bundle inputs must be regular files inside the project")
        manifest[file.relative_to(root).as_posix()] = hashlib.sha256(
            file.read_bytes()
        ).hexdigest()

    output.parent.mkdir(parents=True, exist_ok=True)
    # 不打包 .env、Git 数据、历史、测试、源码映射和本地运行数据。
    with tarfile.open(output, "w:gz") as archive:
        for file in files:
            archive.add(file, arcname=file.relative_to(root).as_posix())
    metadata = {
        "schemaVersion": 1,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "files": manifest,
    }
    output.with_suffix(output.suffix + ".json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--output", type=Path, default=Path(".local/swebench/codeatelier.tar.gz")
    )
    args = parser.parse_args()
    result = prepare(args.root, args.output)
    print(json.dumps({"bundle": str(args.output), "sha256": result["sha256"]}))

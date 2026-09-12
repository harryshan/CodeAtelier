# 文件作用：为手动 SWE-bench 运行打包构建后的后端和依赖清单。
#
# 使用场景与输入输出：
# 手动构建之后生成供容器安装的压缩包，以及描述包内文件与整体 SHA256 的旁侧 JSON。
#
# 代码结构与阅读顺序：
# 1. prepare 确认 dist/server/evaluation/main.js 存在，收集 package.json、锁文件和后端 JavaScript。
# 2. 逐文件拒绝链接或仓库外输入，计算哈希并以仓库相对路径写 tar.gz。
# 3. 写入归档哈希及文件清单，CLI 解析 root/output 后打印生成位置。
#
# 维护注意事项：
# 不打包 .env、Git、历史、源码映射或测试；只打包已构建结果，不在此启动编译或评测。

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
    # Excludes .env, Git, history, tests, source maps and all local data.
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

# 在独立 ext4 夹具准备真实 CodeAtelier 编译输入，不安装依赖或读取私有配置。
# 1. 参数指定 checkout 与新建的空夹具；复制编译输入和现有 node_modules，放入固定编译子命令。
# 2. copytree 保留相对依赖链接，不沿链接读取其它目录；一次性复制不属于 overlay 创建成本。
# 3. 输出准备耗时和输入普通文件分配量，供 project-build-probe 的独立测量引用。
# 只手动执行，保留夹具；不操作用户服务、Git metadata 或 Evaluation。
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time


def measure(root):
    files = 0
    logical = 0
    allocated = 0
    links = 0
    for parent, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            info = (Path(parent) / name).lstat()
            allocated += info.st_blocks * 512
            if stat.S_ISREG(info.st_mode):
                files += 1
                logical += info.st_size
            elif stat.S_ISLNK(info.st_mode):
                links += 1
    return dict(files=files, logicalBytes=logical, allocatedBytes=allocated, symlinks=links)


def main():
    checkout = Path(sys.argv[1]).resolve(strict=True)
    root = Path(sys.argv[2]).resolve(strict=True)
    if (not root.is_dir() or any(root.iterdir()) or root == checkout
            or checkout in root.parents or root in checkout.parents):
        raise ValueError("A separate empty fixture directory is required")

    started = time.monotonic()
    source = root / "source"
    source.mkdir()

    for name in ["src", "node_modules"]:
        shutil.copytree(checkout / name, source / name, symlinks=True)
    for name in ["tsconfig.json", "tsconfig.server.json", "package.json"]:
        shutil.copy2(checkout / name, source / name)
    shutil.copy2(
        checkout / "experiments/native-local-overlay/project-compile.mjs",
        source / "_project-compile.mjs",
    )
    copied_ms = round((time.monotonic() - started) * 1000)
    result = dict(preparationMs=copied_ms, source=measure(source))
    (root / "preparation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

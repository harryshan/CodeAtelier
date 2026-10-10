# 准备独立的 Linux MXC 实验目录，由开发者在 WSL 中手动执行，不进入产品或默认测试。
# 输入是一个尚不存在的绝对目录；输出为校验后的 Node/pnpm、实验 manifest 与源码副本。
# 1. download_checked 只从固定官方地址下载固定版本，并核对事先记录的摘要。
# 2. main 拒绝 root/非 Linux、复用目录及符号链接目录，用安全 tar 解包到本次专属根。
# 3. 仅复制实验文件；不读取项目 .env、宿主凭据，不安装系统包或修改 sysctl。
# 本脚本不执行下载包或安装依赖；调用者审核输出后另行运行 pnpm（禁用安装脚本）。

import base64
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tarfile
import urllib.request


NODE_VERSION = "24.19.0"
PNPM_VERSION = "12.8.1"
NODE_SHA256 = "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"
PNPM_SHA512 = "9kupB1B/XOr+BsjTjmBS0BeURFgOwSed3Vv8EctIqoomRLZlmOB+dh2oSHKp/FfV+QK4f6SdAkGY1VhhKqu+RQ=="


def download_checked(url, destination, algorithm, expected):
    request = urllib.request.Request(url, headers={"User-Agent": "CodeAtelier-MXC-Probe"})
    digest = hashlib.new(algorithm)

    with urllib.request.urlopen(request, timeout=60) as response:
        with destination.open("xb") as target:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                target.write(chunk)

    actual = (
        digest.hexdigest()
        if algorithm == "sha256"
        else base64.b64encode(digest.digest()).decode()
    )
    if actual != expected:
        raise RuntimeError(f"Checksum mismatch: {destination.name}")

    print(f"VERIFIED {destination.name} {algorithm}={actual}", flush=True)


def main():
    if sys.platform != "linux" or os.getuid() == 0 or os.uname().machine != "x86_64":
        raise RuntimeError("Requires non-root Linux x86_64")

    root = Path(sys.argv[1])
    if not root.is_absolute() or root.exists() or root.is_symlink():
        raise RuntimeError("Pass a fresh absolute experiment directory")

    root.mkdir(mode=0o700)
    source = Path(__file__).resolve().parent
    app = root / "app"
    app.mkdir()

    for name in ("package.json", "pnpm-lock.yaml", "probe.mjs", "workload.mjs", "controller.mjs"):
        if (source / name).is_file():
            shutil.copyfile(source / name, app / name)

    node_archive = root / "node.tar.xz"
    download_checked(
        f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz",
        node_archive,
        "sha256",
        NODE_SHA256,
    )
    with tarfile.open(node_archive) as archive:
        archive.extractall(root, filter="data")

    pnpm_archive = root / "pnpm.tgz"
    download_checked(
        f"https://registry.npmjs.org/pnpm/-/pnpm-{PNPM_VERSION}.tgz",
        pnpm_archive,
        "sha512",
        PNPM_SHA512,
    )
    with tarfile.open(pnpm_archive) as archive:
        archive.extractall(root / "pnpm", filter="data")

    print(f"READY root={root} app={app}", flush=True)
    for path in sorted((root / "pnpm/package").iterdir()):
        print(f"PNPM_ENTRY {path.name}")


if __name__ == "__main__":
    main()

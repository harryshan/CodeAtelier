# 把当前后端安装进已准备好的前三题镜像，再按需运行预测和官方评分。
# 由 PowerShell 入口或 Python 命令手动调用，输出新镜像清单和本次运行记录。
#
# 1. refresh_image 从旧镜像启动临时容器，核对题目的 base_commit，再替换应用、安装依赖，
#    检查文件哈希并尝试导入运行时模块。
# 2. 检查通过后保存新镜像，返回镜像 ID、包哈希和检查记录；最后删除临时容器。
# 3. run_stage 调用后续 Python 脚本并检查退出码。
# 4. main 检查本地数据、准备镜像及密钥和缓存配置，为本次运行建目录并打包后端。
# 5. 逐题刷新并保存进度，全部成功后才更新镜像清单；prepare-only 到此结束，否则继续预测和评分。
# 6. 命令入口配置日志和取消信号，用退出码报告取消。
#
# 会安装依赖并创建 Docker 镜像，只能手动执行。只刷新部分题目时，不能把结果写成完整可用的清单。

import argparse
import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

from dataset import load_manifest, load_subset
from predict import execute, upload
from prepare import prepare

LOG = logging.getLogger("swebench.refresh")


def refresh_image(client, entry, row, bundle, metadata, token):
    image = client.images.get(entry["preparedImageId"])
    container = client.containers.create(
        image.id,
        command=["sleep", "infinity"],
        labels={"codeatelier.environmentPreparation": "true"},
    )
    try:
        container.start()
        head = execute(container, ["git", "-C", "/testbed", "rev-parse", "HEAD"])
        if head.decode().strip() != row["base_commit"]:
            raise ValueError("Prepared image base_commit mismatch")
        upload(container, "/installed-agent/codeatelier.tar.gz", bundle.read_bytes())
        # 这个固定的容器目录只放旧版应用，不包含题目代码。
        execute(container, ["rm", "-rf", "/opt/codeatelier/app"])
        execute(container, ["mkdir", "-p", "/opt/codeatelier/app"])
        execute(
            container,
            [
                "tar",
                "-xzf",
                "/installed-agent/codeatelier.tar.gz",
                "-C",
                "/opt/codeatelier/app",
            ],
        )
        execute(
            container,
            [
                "timeout",
                "600",
                "sh",
                "-c",
                "export PATH=/opt/codeatelier/runtime/bin:$PATH; "
                "cd /opt/codeatelier/app; "
                "node /opt/codeatelier/runtime/lib/node_modules/pnpm/bin/pnpm.cjs "
                "install --prod --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com",
            ],
        )
        checksums = "".join(
            f"{digest}  {name}\n" for name, digest in metadata["files"].items()
        )
        upload(container, "/installed-agent/runtime.sha256", checksums.encode())
        execute(
            container,
            ["sha256sum", "--check", "/installed-agent/runtime.sha256"],
            workdir="/opt/codeatelier/app",
        )
        execute(
            container,
            [
                "/opt/codeatelier/runtime/bin/node",
                "--input-type=module",
                "-e",
                "await import('/opt/codeatelier/app/dist/server/evaluation/runner.js')",
            ],
        )
        repository = "codeatelier/swebench-ready-" + row["instance_id"].lower()
        refreshed = container.commit(repository=repository, tag=token)
        return {
            **entry,
            "preparedImage": repository + ":" + token,
            "preparedImageId": refreshed.id,
            "bundleSha256": metadata["sha256"],
            "checks": {
                "head": row["base_commit"],
                "runtimeFilesVerified": True,
                "runtimeImports": True,
            },
        }
    finally:
        container.remove(force=True)


def run_stage(script, arguments, root):
    LOG.info("stage_start script=%s", script)
    subprocess.run(
        [sys.executable, str(root / "scripts/swebench" / script), *map(str, arguments)],
        check=True,
        cwd=root,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Manually refresh and evaluate the prepared first three tasks"
    )
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    os.chdir(root)
    folder = root / ".local/swebench"
    manifest = load_manifest(root / "evals/swebench/subset.json")
    manifest["instance_ids"] = manifest["instance_ids"][:3]
    os.environ["CODEATELIER_SWEBENCH_PARQUET"] = str(
        root / ".local/swebench-verified.parquet"
    )
    rows = load_subset(manifest)
    entries = json.loads((folder / "prepared-environments.json").read_text())[
        "environments"
    ]
    indexed = {entry["instance_id"]: entry for entry in entries}
    if any(row["instance_id"] not in indexed for row in rows):
        raise ValueError("Missing initial prepared images; see docs/swebench.md")

    if not args.prepare_only:
        from dotenv import load_dotenv

        load_dotenv(root / ".env")
        if not os.environ.get("CODEATELIER_API_KEY"):
            raise ValueError("Set CODEATELIER_API_KEY in the environment or .env")
        cache_module = folder / "cn-python"
        if not (cache_module / "sitecustomize.py").is_file():
            raise ValueError(
                "Missing local public-config cache adapter; see docs/swebench.md"
            )
        os.environ["CODEATELIER_SWEBENCH_RAW_CACHE"] = str(folder / "network-cache")
        os.environ["PYTHONPATH"] = (
            str(cache_module) + os.pathsep + os.environ.get("PYTHONPATH", "")
        )

    token = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    preparation = folder / "preparations" / token
    preparation.mkdir(parents=True, exist_ok=False)
    bundle = preparation / "codeatelier.tar.gz"
    metadata = prepare(root, bundle)
    subset = preparation / "subset.json"
    subset.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    import docker

    client = docker.from_env(timeout=900)
    refreshed = []
    try:
        for row in rows:
            LOG.info("refresh_start instance=%s", row["instance_id"])
            refreshed.append(
                refresh_image(
                    client, indexed[row["instance_id"]], row, bundle, metadata, token
                )
            )
    finally:
        client.close()
        # 部分完成的记录只用于排错，不能更新为正式使用的镜像清单。
        (preparation / "progress.json").write_text(
            json.dumps(refreshed, indent=2), encoding="utf-8"
        )
    prepared = preparation / "prepared-environments.json"
    prepared.write_text(
        json.dumps({"environments": refreshed}, indent=2), encoding="utf-8"
    )
    LOG.info(
        "refresh_complete directory=%s bundle_sha256=%s",
        preparation,
        hashlib.sha256(bundle.read_bytes()).hexdigest(),
    )
    if args.prepare_only:
        return
    run = folder / "runs" / ("first-three-" + token)
    LOG.info("evaluation_output directory=%s", run)
    run_stage(
        "predict.py",
        [
            "--subset",
            subset,
            "--output",
            run,
            "--bundle",
            bundle,
            "--prepared-environments",
            prepared,
        ],
        root,
    )
    run_stage("grade.py", ["--run", run], root)
    LOG.info("evaluation_complete report=%s", run / "report.md")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )

    def cancel(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancel)
    try:
        main()
    except KeyboardInterrupt:
        LOG.warning("cancelled")
        sys.exit(130)

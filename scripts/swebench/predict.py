# 文件作用：在一次性 SWE-bench 容器中逐题手动生成补丁。
#
# 使用场景与输入输出：
# 手动读取固定子集，在一次性 Docker 环境中执行生产无界面 agent，收集预测补丁和运行记录。
#
# 代码结构与阅读顺序：
# 1. upload/execute/save_artifacts 封装归档上传、容器命令和记录提取。
# 2. run_trial 准备单题镜像与工作目录，安装 agent 并传入仅含 issue 的提示。
# 3. 单题结束提取工作树补丁及用量，失败或取消也记录状态并清理容器。
# 4. main 解析参数、加载清单与 bundle，逐题执行并写入预测和汇总记录。
#
# 维护注意事项：
# 参考答案不传给 agent；此脚本生成补丁，官方正确性由 grade.py 单独确定。

"""Manually generate patches in disposable SWE-bench containers, one task at a time."""

import argparse
import hashlib
import io
import json
import logging
import os
import signal
import time
import tarfile
import uuid
from pathlib import Path

from dataset import load_manifest, load_subset, prompt_for


def upload(container, path: str, content: bytes) -> None:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        entry = tarfile.TarInfo(path.lstrip("/"))
        entry.size = len(content)
        entry.mode = 0o644
        tar.addfile(entry, io.BytesIO(content))
    container.put_archive("/", archive.getvalue())


def execute(container, command, **kwargs) -> bytes:
    result = container.exec_run(command, **kwargs)
    if result.exit_code:
        # Command output may contain credentials or task data; keep it out of host errors.
        raise RuntimeError(
            f"Container command failed with exit code {result.exit_code}"
        )
    return result.output


def save_artifacts(container, output: Path) -> None:
    # Copy only regular files under this exact prefix; reject links and traversal.
    stream, _ = container.get_archive("/evaluation/output")
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as archive:
        for entry in archive:
            relative = Path(entry.name)
            if not entry.isfile() or relative.is_absolute() or ".." in relative.parts:
                continue
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(entry) as source:
                target.write_bytes(source.read())


def run_trial(client, row: dict, output: Path, bundle: Path, args) -> dict:
    from swebench.harness.test_spec.test_spec import make_test_spec

    container = None
    metadata = {
        "instance_id": row["instance_id"],
        "status": "setup_failed",
    }
    started = time.monotonic()
    patch = ""
    try:
        prepared = getattr(args, "prepared_images", {}).get(row["instance_id"])
        if prepared:
            image = client.images.get(prepared["preparedImage"])
            if image.id != prepared["preparedImageId"]:
                raise ValueError("Prepared image ID changed")
            metadata["image"] = prepared["preparedImage"]
            metadata["baseImageId"] = prepared["baseImageId"]
        else:
            spec = make_test_spec(row, namespace="swebench", arch="x86_64")
            metadata["image"] = spec.instance_image_key
            image = client.images.pull(spec.instance_image_key)
        metadata["imageId"] = image.id
        container = client.containers.create(
            image.id,
            command=["sleep", "infinity"],
            name="codeatelier-swe-" + uuid.uuid4().hex[:12],
            working_dir="/testbed",
            mem_limit="4g",
            nano_cpus=2_000_000_000,
            labels={"codeatelier.evaluation": "swebench"},
        )
        container.start()
        execute(container, ["mkdir", "-p", "/installed-agent", "/evaluation"])
        if not prepared:
            upload(
                container, "/installed-agent/codeatelier.tar.gz", bundle.read_bytes()
            )
            upload(
                container,
                "/installed-agent/codeatelier-install.sh",
                Path(__file__).with_name("install.sh").read_bytes(),
            )
            execute(
                container,
                ["timeout", "600", "bash", "/installed-agent/codeatelier-install.sh"],
            )
        # Ensure the published image really contains the task's intended starting revision.
        head = (
            execute(container, ["git", "rev-parse", "HEAD"], workdir="/testbed")
            .decode()
            .strip()
        )
        if head != row["base_commit"]:
            raise ValueError("Published image does not match base_commit")
        upload(container, "/evaluation/prompt.txt", prompt_for(row).encode())
        command = [
            "bash",
            "-lc",
            "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && exec "
            + "/opt/codeatelier/runtime/bin/node /opt/codeatelier/app/dist/server/evaluation/main.js "
            + "--workspace /testbed --output /evaluation/output --prompt-file /evaluation/prompt.txt "
            + f"--max-total-tokens {args.max_total_tokens} --max-model-calls {args.max_model_calls} "
            + f"--max-steps {args.max_steps} --timeout-ms {args.timeout_ms} --allow-workspace-commands",
        ]
        environment = {
            key: os.environ[key]
            for key in (
                "CODEATELIER_API_KEY",
                "CODEATELIER_BASE_URL",
                "CODEATELIER_MODEL",
            )
            if key in os.environ
        }
        metadata["setupMs"] = (time.monotonic() - started) * 1000
        metadata["status"] = "agent_failed"
        result = container.exec_run(
            ["timeout", str(args.timeout_ms // 1000 + 30), *command],
            environment=environment,
        )
        metadata.update(
            status="completed" if result.exit_code == 0 else "agent_failed",
            exitCode=result.exit_code,
        )
        # Include new, non-ignored files without changing the commit. Hidden tests are applied only by the grader.
        execute(container, ["git", "add", "-N", "."], workdir="/testbed")
        patch = execute(
            container, ["git", "diff", "--binary", "HEAD"], workdir="/testbed"
        ).decode()
    except KeyboardInterrupt:
        metadata["status"] = "cancelled"
        raise
    except Exception as error:
        metadata["errorType"] = type(error).__name__
    finally:
        try:
            save_artifacts(container, output)
        except Exception:
            metadata["artifactsIncomplete"] = True
        try:
            if container is not None:
                container.remove(force=True)
        except Exception:
            metadata["cleanupFailed"] = True
            raise
        finally:
            metadata["wallMs"] = (time.monotonic() - started) * 1000
            (output / "trial.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return {
        "instance_id": row["instance_id"],
        "model_name_or_path": "CodeAtelier",
        "model_patch": patch,
    }


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s swebench %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--subset", type=Path, default=Path("evals/swebench/subset.json")
    )
    parser.add_argument(
        "--bundle", type=Path, default=Path(".local/swebench/codeatelier.tar.gz")
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prepared-environments", type=Path)
    parser.add_argument("--max-total-tokens", type=int, default=500000)
    parser.add_argument("--max-model-calls", type=int, default=60)
    parser.add_argument("--max-steps", type=int, default=30)
    parser.add_argument("--timeout-ms", type=int, default=600000)
    args = parser.parse_args()
    if os.name != "posix" or not os.environ.get("CODEATELIER_API_KEY"):
        parser.error("Use Linux/WSL and set CODEATELIER_API_KEY in the environment")
    for value, maximum in (
        (args.max_total_tokens, 100000000),
        (args.max_model_calls, 1000),
        (args.max_steps, 100),
        (args.timeout_ms, 3600000),
    ):
        if not 1 <= value <= maximum:
            parser.error("Evaluation limit outside supported range")
    if args.timeout_ms < 100:
        parser.error("timeout-ms must be at least 100")
    manifest = load_manifest(args.subset)
    bundle_hash = hashlib.sha256(args.bundle.read_bytes()).hexdigest()
    args.prepared_images = {}
    if args.prepared_environments:
        prepared = json.loads(args.prepared_environments.read_text(encoding="utf-8"))
        entries = prepared["environments"]
        if len({entry["instance_id"] for entry in entries}) != len(entries):
            raise ValueError("Duplicate prepared environment IDs")
        args.prepared_images = {entry["instance_id"]: entry for entry in entries}
        for instance_id in manifest["instance_ids"]:
            entry = args.prepared_images.get(instance_id)
            if entry is None or entry["bundleSha256"] != bundle_hash:
                raise ValueError(
                    "Prepared environment missing or runtime bundle changed"
                )
    rows = load_subset(manifest)
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "subset.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (args.output / "run.json").write_text(
        json.dumps(
            {
                "bundleSha256": bundle_hash,
                "preparedEnvironmentsSha256": hashlib.sha256(
                    args.prepared_environments.read_bytes()
                ).hexdigest()
                if args.prepared_environments
                else None,
                "model": os.environ.get("CODEATELIER_MODEL", "codex/gpt-5.6-luna"),
                "limits": {
                    key: value
                    for key, value in vars(args).items()
                    if isinstance(value, int)
                },
            },
            indent=2,
        )
        + "\n"
    )
    import docker

    client = docker.from_env(timeout=900)
    try:
        with (args.output / "predictions.jsonl").open(
            "w", encoding="utf-8"
        ) as predictions:
            for row in rows:
                output = args.output / row["instance_id"]
                output.mkdir()
                prediction = run_trial(client, row, output, args.bundle, args)
                predictions.write(json.dumps(prediction) + "\n")
                predictions.flush()
                logging.info("event=trial.saved instanceId=%s", row["instance_id"])
    finally:
        client.close()
        from report import write_report

        write_report(args.output)


if __name__ == "__main__":

    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    main()

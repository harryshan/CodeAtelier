# 文件作用：读取固定修订的 SWE-bench 子集并构建不含参考答案的任务提示。
#
# 使用场景与输入输出：
# 供 predict、grade 和契约测试共享，输入固定子集清单，按清单顺序返回数据行或单题提示。
#
# 代码结构与阅读顺序：
# 1. load_manifest 校验实例 ID 非空且唯一、ID 格式和修订 SHA。
# 2. load_subset 校验本地 Parquet 哈希或在线加载指定修订，核对选中实例齐全并按清单重排。
# 3. prompt_for 仅提取 problem_statement，加上工作目录和测试环境说明。
#
# 维护注意事项：
# 加载数据可能访问网络；参考补丁、隐藏测试和 hints 不进入 agent 提示，模块本身不运行任务。

"""Load the explicit, revision-pinned development subset; never execute tasks."""

import hashlib
import os
import json
import re
from pathlib import Path


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    ids = manifest["instance_ids"]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Subset IDs must be nonempty and unique")
    if not all(
        re.fullmatch(r"[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+", value) for value in ids
    ):
        raise ValueError("Invalid instance ID")
    if not re.fullmatch(r"[a-f0-9]{40}", manifest["revision"]):
        raise ValueError("Dataset revision must be a commit SHA")
    return manifest


def load_subset(manifest: dict) -> list[dict]:
    local = os.environ.get("CODEATELIER_SWEBENCH_PARQUET")
    if local:
        import pyarrow.parquet as pq

        path = Path(local)
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["parquetSha256"]:
            raise ValueError("Pinned dataset SHA256 mismatch")
        rows = pq.read_table(path).to_pylist()
    else:
        from datasets import load_dataset

        rows = load_dataset(
            manifest["dataset"], revision=manifest["revision"], split=manifest["split"]
        )
    selected = {
        row["instance_id"]: dict(row)
        for row in rows
        if row["instance_id"] in manifest["instance_ids"]
    }
    missing = set(manifest["instance_ids"]) - selected.keys()
    if missing:
        raise ValueError(f"Subset IDs missing from pinned dataset: {sorted(missing)}")
    return [selected[instance_id] for instance_id in manifest["instance_ids"]]


def prompt_for(row: dict) -> str:
    # Do not expose gold patches, test patches, hints or grading criteria to the agent.
    return (
        "Fix the following issue in /testbed. Read the repository and run relevant "
        "tests. Leave your changes in the working tree; do not commit them. "
        "The Python test environment is available via conda activate testbed.\n\n"
        + row["problem_statement"]
    )

# 读取指定版本的 SWE-bench 子集，为预测和评分脚本提供同一批题目。
# 返回顺序与清单一致的记录，并为 agent 生成不含参考答案的提示。
#
# 1. load_manifest 检查实例 ID 非空、唯一且格式正确，并检查版本 SHA。
# 2. load_subset 校验本地 Parquet 哈希，或下载指定版本；确认题目齐全后按清单排序。
# 3. prompt_for 只取 problem_statement，再补上工作目录和测试环境说明。
#
# 加载数据可能联网，但不会执行题目。参考补丁、隐藏测试和 hints 不能进入 agent 提示。

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
    # 提示中不能包含参考补丁、测试补丁、解题提示或评分条件。
    return (
        "Fix the following issue in /testbed. Read the repository and run relevant "
        "tests. Leave your changes in the working tree; do not commit them. "
        "The Python test environment is available via conda activate testbed.\n\n"
        + row["problem_statement"]
    )

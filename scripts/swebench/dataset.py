# 文件作用：读取固定修订的 SWE-bench 子集并构建不含参考答案的任务提示。
# 代码结构：依次校验清单、按固定修订加载子集、提取 issue 提示；本模块不执行评测任务。

"""Load the explicit, revision-pinned development subset; never execute tasks."""

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

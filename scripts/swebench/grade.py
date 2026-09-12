# 文件作用：手动调用官方评分器，在新容器中验证已保存的预测补丁。
# 代码结构：main 解析运行目录，核对清单及预测实例，准备评分输入并调用官方 harness，保存评分过程记录。

"""Manually grade saved predictions with the official harness in fresh containers."""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from dataset import load_manifest, load_subset


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    manifest = load_manifest(run / "subset.json")
    predictions = [
        json.loads(line)
        for line in (run / "predictions.jsonl").read_text().splitlines()
        if line.strip()
    ]
    ids = [prediction["instance_id"] for prediction in predictions]
    if len(ids) != len(set(ids)) or set(ids) != set(manifest["instance_ids"]):
        raise ValueError(
            "All subset instances must have exactly one prediction before grading"
        )
    grading = run / "grading"
    grading.mkdir(exist_ok=False)  # Never reuse stale official harness result caches.
    dataset = grading / "dataset.json"
    dataset.write_text(json.dumps(load_subset(manifest)), encoding="utf-8")
    started = time.monotonic()
    completed = False
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "swebench.harness.run_evaluation",
                "--dataset_name",
                str(dataset),
                "--predictions_path",
                str(run / "predictions.jsonl"),
                "--max_workers",
                "1",
                "--run_id",
                "codeatelier",
                "--namespace",
                "swebench",
                "--timeout",
                "1800",
            ],
            cwd=grading,
            check=True,
        )
        completed = True
    finally:
        (grading / "timing.json").write_text(
            json.dumps(
                {"wallMs": (time.monotonic() - started) * 1000, "completed": completed}
            )
        )
        from report import write_report

        write_report(run)


if __name__ == "__main__":
    main()

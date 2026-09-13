# 手动调用官方评分器，在新容器中验证已保存的 predictions.jsonl。
# 评分结束后调用 report 模块生成汇总报告。
#
# 1. main 读取运行目录，确认子集中的每题恰好有一份预测。
# 2. 新建 grading 目录并写入指定数据集，避免复用旧评分缓存。
# 3. 用当前 Python 启动官方 harness，设置单 worker、运行 ID 和超时。
# 4. 最后保存耗时和是否完成，再生成离线报告；失败也要留下时间记录。
#
# 会启动评分容器，只能由用户手动执行。生成补丁成功不代表评分通过。

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

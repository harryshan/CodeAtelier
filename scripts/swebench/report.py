# 文件作用：仅从已有评测记录汇总质量、用量、耗时和诊断报告。
# 代码结构：先定义读取和统计函数，再解析补丁、工具及官方评分结果，build_report 聚合指标，write_report 与命令入口写出报告；不调用模型、网络或容器。

"""Aggregate existing artifacts only: no model, container, network or grading calls."""

import argparse
import json
import math
import re
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path


def read_json(path, default=None):
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return default


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def distribution(values):
    values = sorted(value for value in values if isinstance(value, (int, float)))
    return {
        "samples": len(values),
        "total": sum(values) if values else None,
        "mean": statistics.mean(values) if values else None,
        "median": statistics.median(values) if values else None,
        "p95": values[math.ceil(len(values) * 0.95) - 1] if values else None,
    }


def elapsed(start, end):
    try:
        return (
            datetime.fromisoformat(end) - datetime.fromisoformat(start)
        ).total_seconds() * 1000
    except (ValueError, TypeError):
        return None


def patch_metrics(patch):
    if patch is None:
        return None
    lines = patch.splitlines()
    return {
        "nonempty": bool(patch.strip()),
        "bytes": len(patch.encode()),
        "files": sum(line.startswith("diff --git ") for line in lines),
        "addedLines": sum(
            line.startswith("+") and not line.startswith("+++") for line in lines
        ),
        "deletedLines": sum(
            line.startswith("-") and not line.startswith("---") for line in lines
        ),
        "binaryFiles": sum(line == "GIT binary patch" for line in lines),
    }


def result_fields(item):
    # Read/list/search tools may return arrays or text rather than command metadata.
    result = item.get("result")
    return result if isinstance(result, dict) else {}


def process_metrics(events):
    if events is None:
        return None
    starts = [event["data"] for event in events if event["type"] == "tool_start"]
    results = [event["data"] for event in events if event["type"] == "tool_result"]
    by_id = {item.get("callId"): item for item in results}
    failures = sum(
        bool(result_fields(item).get("error"))
        or ("exitCode" in result_fields(item) and item["result"]["exitCode"] != 0)
        for item in results
    )
    test_calls = []
    signatures = Counter()
    for item in starts:
        args = item.get("args", {})
        if item["name"] in ("read_file", "search", "list_files"):
            signatures[json.dumps([item["name"], args], sort_keys=True)] += 1
        if item["name"] == "run_command":
            command = (
                str(args.get("command", "")) + " " + " ".join(args.get("args", []))
            )
            # A command-name heuristic only; exit zero does not prove tests ran or covered the issue.
            if re.search(
                r"\b(pytest|unittest|vitest|jest|ctest|tox)\b|\b(npm|pnpm|yarn|cargo|go|node)\b.*(?:\btest\b|--test)",
                command,
            ):
                test_calls.append(
                    result_fields(by_id.get(item.get("callId"), {})).get("exitCode")
                )
    purpose = Counter()
    steps = set()
    for event in events:
        if event["type"] == "model_usage":
            data = event["data"]
            purpose[data.get("purpose", "unknown")] += data.get("total_tokens", 0)
            if data.get("purpose") == "task" and data.get("step") is not None:
                steps.add(data["step"])
    return {
        "toolCalls": len(starts),
        "toolResults": len(results),
        "missingToolResults": sum(item.get("callId") not in by_id for item in starts),
        "toolFailures": failures,
        "toolFailureRate": ratio(failures, len(results)),
        "toolCallsByName": dict(Counter(item["name"] for item in starts)),
        "toolDurationMs": distribution(item.get("durationMs") for item in results),
        "truncatedToolResults": sum(
            bool(result_fields(item).get("truncated")) for item in results
        ),
        "repeatedReadArguments": sum(count - 1 for count in signatures.values()),
        "testCommandsHeuristic": len(test_calls),
        "testCommandsExitZero": test_calls.count(0),
        "testCommandsUnknownExit": test_calls.count(None),
        "measuredTaskSteps": len(steps),
        "tokensByPurpose": dict(purpose),
    }


def diagnostic_metrics(output):
    files = list((output / "data/logs").glob("app.log*"))
    if not files:
        return None
    counts = Counter()
    for path in files:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                counts[json.loads(line).get("event")] += 1
            except ValueError:
                continue
    return {
        "retryNotices": counts["model.retry"],
        "compactionsCompleted": counts["context.compaction_completed"],
        "compactionsFailed": counts["context.compaction_failed"],
        "coverage": "available log files; rotation may omit older entries",
    }


def official_result(run, instance_id):
    path = (
        run
        / "grading/logs/run_evaluation/codeatelier/CodeAtelier"
        / instance_id
        / "report.json"
    )
    report = read_json(path, {})
    # Fixed v4.1.0 per-instance report; never infer verdict from agent exit status.
    result = report.get(instance_id)
    if not isinstance(result, dict):
        return None
    tests = result.get("tests_status", {})
    metrics = {
        "resolved": result.get("resolved"),
        "patchApplied": result.get("patch_successfully_applied"),
    }
    for source, key in (
        ("FAIL_TO_PASS", "issueTests"),
        ("PASS_TO_PASS", "regressionTests"),
    ):
        group = tests.get(source)
        metrics[key] = (
            {
                "passed": len(group.get("success", [])),
                "failed": len(group.get("failure", [])),
                "passRate": ratio(
                    len(group.get("success", [])),
                    len(group.get("success", [])) + len(group.get("failure", [])),
                ),
            }
            if group is not None
            else None
        )
    return metrics


def build_report(run):
    manifest = read_json(run / "subset.json")
    if manifest is None:
        raise ValueError("Missing subset manifest")
    predictions = {}
    path = run / "predictions.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                item = json.loads(line)
                predictions[item["instance_id"]] = item["model_patch"]
            except (ValueError, KeyError):
                continue
    trials = []
    for instance_id in manifest["instance_ids"]:
        folder = run / instance_id
        output = folder / "output"
        trial = read_json(folder / "trial.json", {})
        agent = read_json(output / "report.json", {})
        usage = read_json(output / "usage.json")
        complete = (
            usage is not None
            and usage.get("calls", 0) > 0
            and usage.get("unmeasuredCalls") == 0
        )
        timings = agent.get("modelTimings")
        trials.append(
            {
                "instanceId": instance_id,
                "repository": instance_id.rsplit("-", 1)[0],
                "status": trial.get("status", "not_run_or_missing"),
                "stopReason": agent.get("stopReason"),
                "official": official_result(run, instance_id),
                "wallMs": trial.get("wallMs"),
                "setupMs": trial.get("setupMs"),
                "agentMs": elapsed(agent.get("startedAt"), agent.get("finishedAt")),
                "usage": usage,
                "usageComplete": complete,
                "cachedInputRatio": ratio(
                    usage.get("cachedInputTokens", 0), usage.get("inputTokens", 0)
                )
                if complete and usage.get("cachedUsageComplete")
                else None,
                "tokenBudgetUsedRatio": ratio(
                    usage.get("totalTokens", 0),
                    agent.get("limits", {}).get("maxTotalTokens"),
                )
                if complete
                else None,
                "modelLatencyMs": distribution(
                    item.get("durationMs") for item in timings
                )
                if timings is not None
                else None,
                "firstTextDeltaMs": distribution(
                    item.get("firstDeltaMs") for item in timings
                )
                if timings is not None
                else None,
                "failedModelCalls": sum(item.get("failed", False) for item in timings)
                if timings is not None
                else None,
                "approvals": agent.get("approvals"),
                "process": process_metrics(read_json(output / "events.json")),
                "diagnostics": diagnostic_metrics(output),
                "patch": patch_metrics(predictions.get(instance_id)),
                "artifactsIncomplete": trial.get(
                    "artifactsIncomplete", not bool(agent)
                ),
            }
        )
    graded = [trial for trial in trials if trial["official"] is not None]
    solved = [trial for trial in graded if trial["official"]["resolved"] is True]
    usage_complete = all(trial["usageComplete"] for trial in trials)
    known_tokens = sum((trial["usage"] or {}).get("totalTokens", 0) for trial in trials)
    repositories = {}
    for trial in trials:
        group = repositories.setdefault(
            trial["repository"], {"selected": 0, "graded": 0, "resolved": 0}
        )
        group["selected"] += 1
        group["graded"] += trial["official"] is not None
        group["resolved"] += bool(
            trial["official"] and trial["official"]["resolved"] is True
        )
    processes = [trial["process"] for trial in trials if trial["process"] is not None]
    test_totals = {}
    for key in ("issueTests", "regressionTests"):
        groups = [
            trial["official"][key]
            for trial in graded
            if trial["official"][key] is not None
        ]
        passed = sum(group["passed"] for group in groups)
        failed = sum(group["failed"] for group in groups)
        test_totals[key] = {
            "samples": len(groups),
            "passed": passed if groups else None,
            "failed": failed if groups else None,
            "passRate": ratio(passed, passed + failed),
        }
    summary = {
        "selected": len(trials),
        "graded": len(graded),
        "resolved": len(solved),
        "ungraded": len(trials) - len(graded),
        "resolvedRateAmongGraded": ratio(len(solved), len(graded)),
        "fullSubsetResolvedRate": ratio(len(solved), len(trials))
        if len(graded) == len(trials)
        else None,
        "statuses": dict(Counter(trial["status"] for trial in trials)),
        "stopReasons": dict(
            Counter(trial["stopReason"] or "unknown" for trial in trials)
        ),
        "knownReportedTokens": known_tokens,
        "usageComplete": usage_complete,
        "usageCompleteTrials": sum(trial["usageComplete"] for trial in trials),
        "totalTokens": known_tokens if usage_complete else None,
        "totalTokensPerResolvedTask": ratio(known_tokens, len(solved))
        if usage_complete
        else None,
        "agentMs": distribution(trial["agentMs"] for trial in trials),
        "wallMs": distribution(trial["wallMs"] for trial in trials),
        "tokensPerTask": distribution(
            trial["usage"]["totalTokens"] for trial in trials if trial["usageComplete"]
        ),
        "solvedTaskTokens": distribution(
            trial["usage"]["totalTokens"] for trial in solved if trial["usageComplete"]
        ),
        "officialTests": test_totals,
        "processSamples": len(processes),
        "toolCalls": distribution(item["toolCalls"] for item in processes),
        "toolFailures": distribution(item["toolFailures"] for item in processes),
        "testCommandsHeuristic": distribution(
            item["testCommandsHeuristic"] for item in processes
        ),
        "modelCalls": distribution(
            trial["usage"]["calls"] for trial in trials if trial["usage"] is not None
        ),
        "setupMs": distribution(trial["setupMs"] for trial in trials),
        "grading": read_json(run / "grading/timing.json"),
        "costUsd": None,
        "byRepository": repositories,
    }
    return {
        "schemaVersion": 1,
        "subset": manifest,
        "run": read_json(run / "run.json"),
        "summary": summary,
        "trials": trials,
        "limitations": [
            "Unknown values are null, not zero; distributions include sample counts.",
            "One attempt per task: no pass@k or repeated-run stability estimate.",
            "Test-command detection and repeated-read counts are heuristics, not quality scores.",
            "Patch size does not measure correctness, maintainability or coverage.",
            "Permission denials do not demonstrate sandbox safety.",
            "First text delta latency excludes tool-only responses and is not provider TTFT.",
            "No dollar estimate without verified pricing; no unsupported composite capability score.",
        ],
    }


def write_report(run):
    report = build_report(Path(run))
    Path(run, "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    summary = report["summary"]
    lines = [
        "# CodeAtelier SWE-bench report",
        "",
        f"Resolved: {summary['resolved']}/{summary['graded']} graded; selected: {summary['selected']}; ungraded: {summary['ungraded']}.",
        "",
        "## 指标概览",
        "",
        "| 指标 | 结果 |",
        "| --- | --- |",
        f"| 官方解决数 / 已评分数 | {summary['resolved']} / {summary['graded']} |",
        f"| 完整子集解决率 | {summary['fullSubsetResolvedRate']} |",
        f"| 已知 token / 用量完整 | {summary['knownReportedTokens']} / {summary['usageComplete']} |",
        f"| Agent 用时中位数 / P95（ms） | {summary['agentMs']['median']} / {summary['agentMs']['p95']} |",
        f"| 每题 token 中位数 / P95 | {summary['tokensPerTask']['median']} / {summary['tokensPerTask']['p95']} |",
        f"| 全部消耗 token / 已解决题数 | {summary['totalTokensPerResolvedTask']} |",
        "",
        "## Summary",
        "",
        "```json",
        json.dumps(summary, indent=2, ensure_ascii=False),
        "```",
        "",
        "## Per-task metrics",
        "",
        "All recorded metrics are included below; null means unknown.",
        "",
    ]
    for trial in report["trials"]:
        lines.extend(
            [
                f"### {trial['instanceId']}",
                "",
                "```json",
                json.dumps(trial, indent=2, ensure_ascii=False),
                "```",
                "",
            ]
        )
    lines.extend(
        ["## Interpretation", "", *["- " + item for item in report["limitations"]], ""]
    )
    Path(run, "report.md").write_text("\n".join(lines), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    write_report(parser.parse_args().run)

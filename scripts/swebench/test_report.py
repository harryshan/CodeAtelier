"""Manual-only report regression cases; never launch a model or grader."""

import json
import tempfile
import unittest
from pathlib import Path

from report import build_report, distribution, patch_metrics, process_metrics


class ReportTests(unittest.TestCase):
    def test_missing_data_is_not_zero_cost_or_failed_grade(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "subset.json").write_text(json.dumps({"instance_ids": ["a__b-1"]}))
            report = build_report(run)
            self.assertIsNone(report["summary"]["totalTokens"])
            self.assertIsNone(report["summary"]["fullSubsetResolvedRate"])
            self.assertEqual(report["summary"]["ungraded"], 1)
            self.assertIsNone(report["trials"][0]["process"])

    def test_official_verdict_and_regression_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "subset.json").write_text(json.dumps({"instance_ids": ["a__b-1"]}))
            folder = run / "grading/logs/run_evaluation/codeatelier/CodeAtelier/a__b-1"
            folder.mkdir(parents=True)
            (folder / "report.json").write_text(
                json.dumps(
                    {
                        "a__b-1": {
                            "resolved": False,
                            "patch_successfully_applied": True,
                            "tests_status": {
                                "FAIL_TO_PASS": {"success": ["fixed"], "failure": []},
                                "PASS_TO_PASS": {
                                    "success": [],
                                    "failure": ["regressed"],
                                },
                            },
                        }
                    }
                )
            )
            summary = build_report(run)["summary"]
            self.assertEqual(summary["fullSubsetResolvedRate"], 0)
            self.assertEqual(summary["officialTests"]["regressionTests"]["failed"], 1)

    def test_patch_headers_do_not_count_as_changed_lines(self):
        result = patch_metrics(
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"
        )
        self.assertEqual(
            (result["files"], result["addedLines"], result["deletedLines"]), (1, 1, 1)
        )

    def test_missing_tool_result_and_nonzero_test_exit(self):
        events = [
            {
                "type": "tool_start",
                "data": {
                    "name": "run_command",
                    "callId": "1",
                    "args": {"command": "pytest", "args": []},
                },
            },
            {
                "type": "tool_result",
                "data": {
                    "name": "run_command",
                    "callId": "1",
                    "result": {"exitCode": 1},
                    "durationMs": 10,
                },
            },
            {
                "type": "tool_start",
                "data": {"name": "read_file", "callId": "2", "args": {"path": "x"}},
            },
        ]
        metrics = process_metrics(events)
        self.assertEqual(metrics["toolFailures"], 1)
        self.assertEqual(metrics["missingToolResults"], 1)
        self.assertEqual(metrics["testCommandsHeuristic"], 1)
        self.assertEqual(metrics["testCommandsExitZero"], 0)

    def test_distribution_excludes_missing_values(self):
        result = distribution([None, 1, 2, 9])
        self.assertEqual(
            (result["samples"], result["median"], result["p95"]), (3, 2, 9)
        )

    def test_list_tool_results_are_valid(self):
        events = [
            {
                "type": "tool_result",
                "data": {
                    "name": "list_files",
                    "callId": "1",
                    "result": [{"name": "src"}],
                    "durationMs": 3,
                },
            }
        ]
        result = process_metrics(events)
        self.assertEqual(result["toolResults"], 1)
        self.assertEqual(result["toolFailures"], 0)
        self.assertEqual(result["truncatedToolResults"], 0)

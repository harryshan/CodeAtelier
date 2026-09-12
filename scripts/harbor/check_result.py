"""Check a manually run Harbor job against an expected independent verdict."""

import argparse
import json
from pathlib import Path


def check(job: Path, reward: float, contract: bool = False) -> None:
    results = [
        json.loads(file.read_text(encoding="utf-8"))
        for file in job.glob("*/result.json")
    ]
    if len(results) != 1:
        raise ValueError("Expected exactly one trial result")
    result = results[0]
    if result.get("exception_info") is not None:
        raise ValueError("Harbor trial reported an exception")
    if (result.get("verifier_result") or {}).get("rewards", {}).get("reward") != reward:
        raise ValueError("Independent verifier returned an unexpected reward")
    if contract:
        context = result["agent_result"]
        if context["n_input_tokens"] != 400 or context["n_output_tokens"] != 80:
            raise ValueError("Adapter did not return expected fixture usage")
        metadata = context["metadata"]
        report = metadata["codeatelierReport"]
        if (
            report["task"]["status"] != "completed"
            or report["approvals"]["allowed"] != 1
        ):
            raise ValueError("Production agent/approval loop did not complete")
        events_file = next(job.glob("*/agent/codeatelier/events.json"))
        events = json.loads(events_file.read_text(encoding="utf-8"))
        if not any(
            event["type"] == "tool_result"
            and event["data"].get("name") == "run_command"
            and event["data"].get("result", {}).get("exitCode") == 0
            for event in events
        ):
            raise ValueError("Agent did not successfully execute the visible tests")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    parser.add_argument("--reward", type=float, required=True)
    parser.add_argument("--contract", action="store_true")
    args = parser.parse_args()
    check(args.job, args.reward, args.contract)
    print("Harbor independent verdict and requested contract checks passed.")

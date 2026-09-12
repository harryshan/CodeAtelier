"""Create a disposable Harbor smoke task with an in-container mock model server."""

import argparse
import shutil
from pathlib import Path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path(".local/harbor/contract-add")
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    # copytree intentionally refuses an existing trial definition.
    shutil.copytree(root / "evals/harbor/smoke-add", args.output)
    shutil.copyfile(
        Path(__file__).with_name("contract-model.mjs"),
        args.output / "environment/contract-model.mjs",
    )
    with (args.output / "environment/Dockerfile").open(
        "a", encoding="utf-8"
    ) as dockerfile:
        dockerfile.write(
            '\nCOPY contract-model.mjs /opt/codeatelier-contract-model.mjs\nENTRYPOINT ["node", "/opt/codeatelier-contract-model.mjs"]\n'
        )

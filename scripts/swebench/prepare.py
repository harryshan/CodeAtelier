"""Package only built runtime files and dependency manifests for SWE-bench."""

import argparse
import hashlib
import json
import tarfile
from pathlib import Path


def prepare(root: Path, output: Path) -> dict:
    root = root.resolve()
    runtime = root / "dist/server"
    if not (runtime / "evaluation/main.js").is_file():
        raise ValueError("Run pnpm exec tsc -p tsconfig.server.json first")

    files = [root / "package.json", root / "pnpm-lock.yaml"]
    files.extend(sorted(runtime.rglob("*.js")))
    manifest = {}
    for file in files:
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise ValueError("Bundle inputs must be regular files inside the project")
        manifest[file.relative_to(root).as_posix()] = hashlib.sha256(
            file.read_bytes()
        ).hexdigest()

    output.parent.mkdir(parents=True, exist_ok=True)
    # Excludes .env, Git, history, tests, source maps and all local data.
    with tarfile.open(output, "w:gz") as archive:
        for file in files:
            archive.add(file, arcname=file.relative_to(root).as_posix())
    metadata = {
        "schemaVersion": 1,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "files": manifest,
    }
    output.with_suffix(output.suffix + ".json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--output", type=Path, default=Path(".local/swebench/codeatelier.tar.gz")
    )
    args = parser.parse_args()
    result = prepare(args.root, args.output)
    print(json.dumps({"bundle": str(args.output), "sha256": result["sha256"]}))

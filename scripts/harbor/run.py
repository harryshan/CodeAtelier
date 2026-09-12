"""Run Harbor with this repository's custom adapter on Python's import path."""

import os
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.setdefault("HARBOR_TELEMETRY", "0")

if __name__ == "__main__":
    import_module("harbor.cli.main").app()

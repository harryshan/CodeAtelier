# 手动检查非特权 OverlayFS mount namespace 与宿主路径的互操作，不进入默认检查。
# 1. keeper 在 Bubblewrap 私有 mount namespace 内报告宿主 PID 并保持挂载。
# 2. main 创建独占合成 lower/upper，检查 proc-root 访问及 realpath 的实际结果。
# 3. Process 管理有界响应与关闭；结果仅写本夹具 report.json，退出不删除证据。
# 此探针不是 Sandbox 或发布验收，不访问真实项目，不安装包或修改系统配置。

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location(
    "stable_lower_probe", Path(__file__).with_name("stable-lower-probe.py")
)
stable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stable)
Process = stable.Process


def keeper():
    print(json.dumps({"state": "ready", "pid": os.getpid()}), flush=True)
    for line in sys.stdin:
        if line.strip() == "close":
            return


def main():
    if "--worker" in sys.argv:
        keeper()
        return
    parent = Path.home() / "codeatelier-native-overlay-probes"
    root = Path(tempfile.mkdtemp(prefix="namespace-", dir=parent))
    for name in ("lower", "upper", "work", "view"):
        (root / name).mkdir()
    (root / "lower" / "source.txt").write_text("fixture")
    child = Process([
        "bwrap", "--unshare-user", "--unshare-net", "--unshare-ipc",
        "--unshare-uts", "--die-with-parent", "--new-session",
        "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
        "--overlay-src", str(root / "lower"), "--overlay",
        str(root / "upper"), str(root / "work"), str(root / "view"),
        "--chdir", str(root / "view"), sys.executable, "-B", "-u",
        str(Path(__file__).resolve()), "--worker",
    ])
    report = {}
    try:
        portal = Path(f"/proc/{child.ready['pid']}/root") / str(root / "view").lstrip("/")
        try:
            report["directRead"] = (portal / "source.txt").read_text() == "fixture"
            resolved = portal.resolve(strict=True)
            report["realpathPreservesContent"] = (resolved / "source.txt").exists()
            (portal / "private.txt").write_text("private")
            report["directWriteUpper"] = (root / "upper" / "private.txt").read_text() == "private"
        except OSError as error:
            report["errno"] = error.errno
    finally:
        child.close()
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"report": str(root / "report.json"), **report}))
    assert report.get("directRead") is True, report
    assert report.get("directWriteUpper") is True, report
    assert report.get("realpathPreservesContent") is False, report


if __name__ == "__main__":
    main()

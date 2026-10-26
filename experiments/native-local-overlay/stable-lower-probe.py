# 手动验证只读 FUSE 基线与内核 OverlayFS 的组合，输入 helper 路径与夹具规模。
# 1. worker 仅执行固定读取、目录枚举、首读过期和私有写入断言。
# 2. Process 管理本控制器启动的进程、管道、响应期限与退出，不安装系统组件。
# 3. overlay 用 Bubblewrap 建立私有命名空间；sample 在独占 ext4 目录生成
#    合成文件，再测量挂载/首读成本，并检查来源变化、copy-up 与卸载。
# 4. main 比较小/大目录，保留私有数据及只含计数和状态的 JSON 报告。
#    不运行 Evaluation、不访问用户项目，也不替代产品 Sandbox/发布验收。

import argparse
import errno
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time

from probe import allocation


ORIGINAL = "a = 1\nb = 2\n"
EXTERNAL = "a = 1\nb = 20\n"
PRIVATE = "a = 10\nb = 2\n"


def emit(value):
    print(json.dumps(value), flush=True)


def worker():
    filesystem = subprocess.check_output(
        ["stat", "-f", "-c", "%T", "."], text=True
    ).strip()
    assert filesystem == "overlayfs", filesystem
    emit({"state": "ready"})
    for line in sys.stdin:
        action = line.strip()
        if action == "close":
            return
        if action == "read":
            assert Path("module.py").read_text() == ORIGINAL
            assert not Path(".git/sentinel").exists()
            emit({"state": "original"})
        elif action == "list":
            assert "late.py" not in os.listdir(".")
            emit({"state": "stable-directory"})
        elif action == "observe":
            assert Path("pending.py").stat().st_size == len(ORIGINAL)
            emit({"state": "observed"})
        elif action == "stale-read":
            try:
                Path("pending.py").read_text()
            except OSError as error:
                assert error.errno == errno.ESTALE, error
            else:
                raise AssertionError("Read mixed cached metadata with changed bytes")
            emit({"state": "stale-read-rejected"})
        elif action == "modify":
            assert Path("module.py").read_text() == ORIGINAL
            Path("module.py").write_text(PRIVATE)
            assert Path("module.py").read_text() == PRIVATE
            emit({"state": "private"})
        else:
            raise AssertionError("Unknown fixed worker action")


class Process:
    """Bounded receipt and clean exit for a process created by this controller."""

    def __init__(self, command):
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        try:
            self.ready = self.receive()
            assert self.ready["state"] == "ready", self.ready
        except BaseException:
            self.close(expect_success=False)
            raise

    def receive(self):
        if not self.selector.select(timeout=20):
            raise TimeoutError("Owned process receipt timed out")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Owned process exited before receipt")
        return json.loads(line)

    def send(self, command):
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def request(self, command):
        self.send(command)
        return self.receive()

    def close(self, expect_success=True):
        try:
            if self.process.poll() is None:
                self.send("close")
                self.process.wait(timeout=10)
            if expect_success:
                assert self.process.returncode == 0, self.process.returncode
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=10)
            self.process.stdin.close()
            self.process.stdout.close()
            self.selector.close()


def overlay(root, lower):
    for name in ("upper", "work", "view"):
        (root / name).mkdir()
    view = root / "view"
    return Process([
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
        "--overlay-src", str(lower), "--overlay", str(root / "upper"),
        str(root / "work"), str(view), "--chdir", str(view),
        sys.executable, "-B", "-u", str(Path(__file__).resolve()), "--worker",
    ])


def sample(root, binary, files):
    root.mkdir()
    source = root / "source"
    source.mkdir()
    (source / "module.py").write_text(ORIGINAL)
    (source / "pending.py").write_text(ORIGINAL)
    (source / ".git").mkdir()
    (source / ".git" / "sentinel").write_text("hidden")
    for index in range(files):
        folder = source / f"dir-{index // 1000:04d}"
        folder.mkdir(exist_ok=True)
        (folder / f"file-{index:06d}").touch()
    control = root / "control"
    mount = root / "lower"
    control.mkdir()
    mount.mkdir()
    lower = None
    view = None
    result = {"additionalFiles": files}
    try:
        started = time.monotonic_ns()
        lower = Process([str(binary), str(source), str(control), str(mount)])
        result["lowerReadyMs"] = (time.monotonic_ns() - started) / 1e6
        result["lowerReady"] = lower.ready
        assert lower.ready["nodes"] == 1
        assert lower.ready["enumerations"] == lower.ready["objects"] == 0
        started = time.monotonic_ns()
        view = overlay(root, mount)
        result["overlayReadyMs"] = (time.monotonic_ns() - started) / 1e6
        result["mounted"] = lower.request("metrics")
        assert result["mounted"]["enumerations"] == 0
        assert result["mounted"]["objects"] == 0
        result["emptyUpper"] = allocation(root / "upper")
        started = time.monotonic_ns()
        assert view.request("read")["state"] == "original"
        result["firstReadMs"] = (time.monotonic_ns() - started) / 1e6
        assert lower.request("verify")["valid"]
        result["afterRead"] = lower.request("metrics")
        assert result["afterRead"]["objects"] == 1
        assert result["afterRead"]["copiedBytes"] == len(ORIGINAL)
        assert view.request("list")["state"] == "stable-directory"
        assert view.request("observe")["state"] == "observed"

        # External source changes are deliberate: the kernel sees only the
        # readonly cache, never the mutable source as its underlying lower.
        (source / "module.py").write_text(EXTERNAL)
        assert not lower.request("verify")["valid"]
        result["changedFileDetected"] = True
        (source / "pending.py").write_text(EXTERNAL)
        assert view.request("stale-read")["state"] == "stale-read-rejected"
        result["changedBeforeFirstReadRejected"] = True
        (source / "late.py").write_text("new source member")
        assert view.request("read")["state"] == "original"
        assert view.request("list")["state"] == "stable-directory"
        assert not lower.request("verify")["valid"]
        assert view.request("modify")["state"] == "private"
        assert (source / "module.py").read_text() == EXTERNAL
        assert (root / "upper" / "module.py").read_text() == PRIVATE
        result["stableReadAndDirectory"] = True
        result["staleSourceDetected"] = True
        result["nativeCopyUpPreservedSource"] = True
        result["privateUpper"] = allocation(root / "upper")
        result["baselineStorage"] = allocation(control)
    finally:
        try:
            if view is not None:
                view.close()
        finally:
            if lower is not None:
                lower.close()
            if os.path.ismount(mount):
                subprocess.run(["fusermount3", "-u", str(mount)], check=True)
            assert not os.path.ismount(mount), "Owned lower mount remains"
    result["cleanUnmount"] = True
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--files", type=int, default=100000)
    parser.add_argument("--binary", type=Path)
    args = parser.parse_args()
    if args.worker:
        worker()
        return
    assert args.binary is not None and args.binary.is_absolute()
    assert 0 <= args.files <= 100000
    parent = Path.home() / "codeatelier-native-overlay-probes"
    parent.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="stable-", dir=parent))
    report = {"schemaVersion": 1, "passed": False, "samples": []}
    try:
        for index, count in enumerate([0, args.files]):
            report["samples"].append(sample(root / str(index), args.binary, count))
        report["passed"] = True
    finally:
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        emit({"report": str(root / "report.json"), **report})


if __name__ == "__main__":
    main()

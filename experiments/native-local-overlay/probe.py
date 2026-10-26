"""Manual Linux OverlayFS primitive probe, independent of product and Evaluation.

1. The controller creates only its own ext4 fixture under a dedicated home
   directory and known test files. Fixture generation is excluded from mount
   timing and allocation data.
2. Watch observes OPEN/ACCESS on fixture directories; Worker launches the real
   Bubblewrap overlay in private namespaces with a read-only host filesystem.
3. Mount-only samples compare empty and populated lower trees. Parallel workers
   modify separate uppers, then verify source preservation and normal remount.
4. A fresh candidate tests explicitly prepared merged bytes. This does not
   implement automatic baselines, dependency capture, or source publication.
5. Owned workers always receive close or are killed and waited; reports and
   private artifacts remain for inspection. No package/driver installation,
   partition changes, existing-service restart, or automatic test registration.
"""

import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import runpy
import selectors
import struct
import subprocess
import sys
import tempfile
import time


ORIGINAL = "a = 1\nb = 2\n"
IN_ACCESS = 0x00000001
IN_OPEN = 0x00000020
IN_Q_OVERFLOW = 0x00004000
IN_ISDIR = 0x40000000


def respond(value):
    print(json.dumps(value), flush=True)


def worker(source):
    """Fixed actions inside the native mount, not a general command API."""
    filesystem = subprocess.check_output(
        ["stat", "-f", "-c", "%T", "."], text=True
    ).strip()
    assert filesystem == "overlayfs", filesystem
    respond({"state": "ready", "filesystem": filesystem, "uid": os.getuid()})
    for line in sys.stdin:
        action = json.loads(line)
        if action["action"] == "close":
            return

        if action["action"] == "modify":
            started = time.monotonic_ns()
            label = action["label"]
            assert Path("module.py").read_text() == ORIGINAL
            assert not Path(".git/sentinel").exists()
            for target in [Path(source) / "module.py", Path(".git/forbidden")]:
                try:
                    with target.open("w"):
                        pass
                except OSError as error:
                    assert error.errno in (13, 30), error
                else:
                    raise AssertionError("Read-only boundary allowed writing")

            changed = (
                ORIGINAL.replace("1", "10")
                if label == "A"
                else ORIGINAL.replace("2", "20")
            )
            Path("module.py").write_text(changed)
            Path(f"artifact-{label}").write_text("private")
            time.sleep(0.2)
            respond({"state": "modified", "interval": [started, time.monotonic_ns()]})
        elif action["action"] == "check":
            label = action["label"]
            expected = (
                ORIGINAL.replace("1", "10")
                if label == "A"
                else ORIGINAL.replace("2", "20")
            )
            assert Path("module.py").read_text() == expected
            assert Path(f"artifact-{label}").read_text() == "private"
            assert not Path(f"artifact-{'B' if label == 'A' else 'A'}").exists()
            respond({"state": "isolated"})
        elif action["action"] == "candidate":
            assert Path("module.py").read_text() == ORIGINAL
            assert not Path("artifact-A").exists()
            assert not Path("artifact-B").exists()
            Path("module.py").write_text("a = 10\nb = 20\n")
            result = runpy.run_path("module.py")
            assert result["a"] + result["b"] == 30
            respond({"state": "candidate-passed"})
        else:
            raise AssertionError("Unknown fixture action")


class Watch:
    """Bounded watches for fixture directories known during preparation."""

    def __init__(self, directories):
        libc = ctypes.CDLL(None, use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        try:
            for directory in directories:
                mask = IN_ACCESS | IN_OPEN
                if libc.inotify_add_watch(self.fd, os.fsencode(directory), mask) < 0:
                    raise OSError(ctypes.get_errno(), "inotify_add_watch")
        except BaseException:
            self.close()
            raise

    def events(self):
        files = 0
        directories = 0
        while True:
            try:
                block = os.read(self.fd, 1024 * 1024)
            except BlockingIOError:
                return {"fileOpenOrAccess": files, "directoryOpenOrAccess": directories}
            offset = 0
            while offset < len(block):
                _, mask, _, length = struct.unpack_from("iIII", block, offset)
                assert not mask & IN_Q_OVERFLOW, "inotify queue overflow"
                if mask & IN_ISDIR:
                    directories += 1
                else:
                    files += 1
                offset += 16 + length

    def close(self):
        os.close(self.fd)


class Worker:
    """Own one Bubblewrap process; keep upper/work private and reusable."""

    def __init__(self, root, source, label):
        self.storage = root / label
        self.storage.mkdir(exist_ok=True)
        for name in ("upper", "work", "empty", "view"):
            (self.storage / name).mkdir(exist_ok=True)
        view = self.storage / "view"
        command = [
            "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
            "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
            "--overlay-src", str(source),
            "--overlay", str(self.storage / "upper"), str(self.storage / "work"), str(view),
            "--ro-bind", str(self.storage / "empty"), str(view / ".git"),
            "--chdir", str(view), sys.executable, "-B", "-u",
            str(Path(__file__).resolve()), "--worker", str(source),
        ]
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        try:
            assert self.receive()["state"] == "ready"
        except BaseException:
            self.close(expect_success=False)
            raise

    def send(self, action):
        self.process.stdin.write(json.dumps(action) + "\n")
        self.process.stdin.flush()

    def receive(self):
        if not self.selector.select(timeout=30):
            raise TimeoutError("Owned overlay worker did not respond")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Owned overlay worker exited before its receipt")
        return json.loads(line)

    def close(self, expect_success=True):
        try:
            if self.process.poll() is None:
                self.send({"action": "close"})
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=10)
                    raise
            if expect_success:
                assert self.process.returncode == 0, self.process.returncode
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=10)
            self.selector.close()


def allocation(directory):
    """Walk only the small private upper, never the source tree."""
    files = []
    blocks = 0
    for parent, _, names in os.walk(directory):
        blocks += os.lstat(parent).st_blocks * 512
        for name in names:
            target = Path(parent) / name
            files.append(str(target.relative_to(directory)))
            blocks += target.lstat().st_blocks * 512
    return {"files": sorted(files), "allocatedBytes": blocks}


def fixture(root, count):
    source = root / f"lower-{count}"
    source.mkdir()
    (source / ".git").mkdir()
    (source / ".git/sentinel").write_text("private metadata")
    (source / "module.py").write_text(ORIGINAL)
    directories = [source, source / ".git"]
    for group in range((count + 999) // 1000):
        directory = source / f"group-{group}"
        directory.mkdir()
        directories.append(directory)
        for item in range(min(1000, count - group * 1000)):
            (directory / f"file-{item}").touch()
    return source, directories


def controller(count):
    assert sys.platform == "linux" and os.getuid() != 0
    parent = Path.home() / "codeatelier-native-overlay-probes"
    parent.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    report = {
        "root": str(root), "platform": platform.platform(), "samples": [],
        "limitations": [
            "Native Bubblewrap/OverlayFS primitives, not CodeAtelier Runtime or publication integration",
            "Lower is unchanged during every supported mount; no live lower guarantee",
            "Root .git metadata masked read-only; nested repository policy not implemented",
            "No automatic baseline or read dependency capture; candidate bytes explicitly supplied",
            "Allocation excludes filesystem metadata outside upper; timings include Python/Bubblewrap startup",
        ],
    }
    workers = []
    try:
        for size in (0, count):
            source, directories = fixture(root, size)
            watch = Watch(directories)
            try:
                for sample in range(3):
                    watch.events()
                    started = time.perf_counter()
                    current = Worker(root, source, f"sample-{size}-{sample}")
                    workers.append(current)
                    elapsed = (time.perf_counter() - started) * 1000
                    events = watch.events()
                    disk = allocation(current.storage / "upper")
                    assert events == {
                        "fileOpenOrAccess": 0, "directoryOpenOrAccess": 0,
                    }, events
                    assert disk["files"] == [], disk
                    current.close()
                    workers.remove(current)
                    report["samples"].append({
                        "additionalFiles": size, "mountAndReadyMs": elapsed,
                        "observedLowerEvents": events, "upper": disk,
                    })
            finally:
                watch.close()

        left = Worker(root, source, "session-A")
        workers.append(left)
        right = Worker(root, source, "session-B")
        workers.append(right)
        left.send({"action": "modify", "label": "A"})
        right.send({"action": "modify", "label": "B"})
        a = left.receive()["interval"]
        b = right.receive()["interval"]
        assert max(a[0], b[0]) < min(a[1], b[1])
        for current, label in ((left, "A"), (right, "B")):
            current.send({"action": "check", "label": label})
            assert current.receive()["state"] == "isolated"
            current.close()
            workers.remove(current)
        assert (source / "module.py").read_text() == ORIGINAL

        remounted = Worker(root, source, "session-A")
        workers.append(remounted)
        remounted.send({"action": "check", "label": "A"})
        assert remounted.receive()["state"] == "isolated"
        remounted.close()
        workers.remove(remounted)

        candidate = Worker(root, source, "candidate")
        workers.append(candidate)
        candidate.send({"action": "candidate"})
        assert candidate.receive()["state"] == "candidate-passed"
        candidate.close()
        workers.remove(candidate)
        assert (source / "module.py").read_text() == ORIGINAL
        report["privateLayers"] = {
            label: allocation(root / label / "upper")
            for label in ("session-A", "session-B", "candidate")
        }
        report["parallelIntervals"] = [a, b]
        report["checks"] = [
            "parallel private writes",
            "source write denied",
            "root Git metadata masked",
            "normal remount retained upper",
            "fresh candidate validated supplied merged bytes",
        ]
        report["passed"] = True
    except BaseException as error:
        report["passed"] = False
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        cleanup_errors = []
        for current in workers:
            try:
                current.close()
            except BaseException as error:
                cleanup_errors.append(f"{type(error).__name__}: {error}")
        if cleanup_errors:
            report["passed"] = False
            report["cleanupErrors"] = cleanup_errors
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"NATIVE_OVERLAY_REPORT {root / 'report.json'}", flush=True)
        if cleanup_errors:
            raise RuntimeError("Owned overlay cleanup failed; inspect report")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker")
    parser.add_argument("--files", type=int, default=10000)
    arguments = parser.parse_args()
    if arguments.worker:
        worker(arguments.worker)
    else:
        assert 1 <= arguments.files <= 100000
        controller(arguments.files)

# 手动验证 Linux lower 的首读与 seal 持久化边界，使用带 sync-wrapper.cpp 的测试 helper。
# 1. events 读取链接包装器产生的同步次序；未创建记录等于零次调用，不等于断电实验。
# 2. sample 在独占 ext4 夹具真实挂载 FUSE，检查稳定首读、seal 对象/清单/目录同步次序。
# 3. check_results 核对对象 fsync/范围写回 EIO 不交付清单；写回不支持仍须 fsync 后成功。
# 4. main 保存耗时/计数/断言报告并正常关闭自有挂载；失败保留证据，不操作产品服务或 Evaluation。
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location(
    "stable_probe", Path(__file__).with_name("stable-lower-probe.py")
)
stable_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stable_probe)


def events(control):
    file = control / "sync-events"
    if not file.exists():
        return []
    return [dict(zip(["kind", "micros", "result"], line.split()))
            for line in file.read_text().splitlines()]


def sample(root, binary, fault=None):
    source = root / "source"
    control = root / "control"
    mount = root / "view"
    for directory in [source, control, mount]:
        directory.mkdir(parents=True)

    count = 1 if fault else 128
    contents = {f"file-{index:03d}": (str(index) + " content\n").encode() * 128
                for index in range(count)}
    for name, content in contents.items():
        (source / name).write_bytes(content)

    lower = stable_probe.Process([str(binary), str(source), str(control), str(mount)])
    try:
        assert lower.ready["objects"] == lower.ready["enumerations"] == 0
        started = time.monotonic()
        for name, content in contents.items():
            assert (mount / name).read_bytes() == content

        read_ms = (time.monotonic() - started) * 1000
        first_events = events(control)
        (source / "file-000").write_bytes(b"changed externally\n")
        assert (mount / "file-000").read_bytes() == contents["file-000"]
        if fault:
            (control / fault).touch()

        identifier = str(uuid.uuid4())
        started = time.monotonic()
        receipt = lower.request("seal " + identifier)
        seal_ms = (time.monotonic() - started) * 1000
        calls = events(control)
        manifest = control / (identifier + ".json")
        result = dict(
            readMs=read_ms, sealMs=seal_ms, objectCount=count,
            firstReadSyncCalls=len(first_events),
            firstReadSyncMicros=sum(int(e["micros"]) for e in first_events),
            calls=calls, receipt=receipt, manifestExists=manifest.exists(), stableRead=True,
            cachedObjects=len(list(control.glob("object-*"))),
        )
        if fault not in ["sync-fail", "writeback-fail"]:
            assert receipt["state"] == "sealed" and receipt["valid"]
            document = json.loads(manifest.read_text())
            entries = [entry for entry in document["entries"] if entry["object"]]
            assert len(entries) == count
            for entry in entries:
                assert (control / entry["object"]).read_bytes() == contents[entry["path"]]
            result["capturedContentsMatch"] = True

        return result
    finally:
        lower.close()


def check_results(normal, failed, unsupported, writeback_failed):
    for result in [normal, failed, unsupported, writeback_failed]:
        assert result["firstReadSyncCalls"] == 0

    assert [e["kind"] for e in normal["calls"]] == (
        ["writeback"] * 128 + ["object"] * 128 + ["manifest", "directory"]
    )
    assert all(e["result"] == "0" for e in normal["calls"])

    for result in [failed, writeback_failed]:
        assert result["receipt"]["state"] == "seal-failed"
        assert result["receipt"]["valid"] is False
        assert not result["manifestExists"]
        assert result["cachedObjects"] == 1
        assert result["calls"][-1]["result"] == "-1"
    assert failed["calls"][-1]["kind"] == "object"
    assert len(writeback_failed["calls"]) == 1
    assert writeback_failed["calls"][0]["kind"] == "writeback"

    assert [e["kind"] for e in unsupported["calls"]] == [
        "writeback", "object", "manifest", "directory"
    ]
    assert [e["result"] for e in unsupported["calls"]] == ["-1", "0", "0", "0"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    args = parser.parse_args()
    parent = Path.home() / "codeatelier-native-overlay-probes"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="sync-", dir=parent))
    binary = args.binary.resolve(strict=True)
    normal = sample(root / "normal", binary)
    failed = sample(root / "failed", binary, fault="sync-fail")
    unsupported = sample(root / "unsupported", binary, fault="writeback-unsupported")
    writeback_failed = sample(root / "writeback-failed", binary, fault="writeback-fail")
    result = dict(passed=False, normal=normal, failed=failed,
                  unsupported=unsupported, writebackFailed=writeback_failed)
    try:
        check_results(normal, failed, unsupported, writeback_failed)
        result["passed"] = True
    finally:
        (root / "report.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(dict(
            root=str(root), passed=result["passed"], readMs=normal["readMs"],
            sealMs=normal["sealMs"], firstReadSyncCalls=normal["firstReadSyncCalls"],
            firstReadSyncMicros=normal["firstReadSyncMicros"],
        )), flush=True)


if __name__ == "__main__":
    main()

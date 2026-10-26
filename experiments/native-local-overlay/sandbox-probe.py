# 手动连接只读 FUSE lower、内核 OverlayFS 和当前生产 MXC Runtime。
# 1. 外层创建独占 ext4 夹具并记录宿主 mount namespace，启动同 UID 私有 namespace。
# 2. inside 仅在新 namespace 保留挂载能力，创建两个按需 lower 和原生 overlay。
# 3. setpriv 撤销 Broker 子进程的全部 capabilities，再执行当前打包的 Runtime 探针；
#    来源与 Broker 目录不作为 Runtime 可写根，参数只来自操作者提供的实验路径。
# 4. Runtime 确认退出后先 umount overlay，再关闭 lower；不使用 lazy/force 卸载。
#    可选 publish 阶段通过独占管道创建候选、导出真实 seal，并复用生产发布器。
# 5. 报告及私有数据保留，宿主检查挂载未传播；不安装、重启现有服务或运行 Evaluation。

import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


spec = importlib.util.spec_from_file_location(
    "stable_lower_probe", Path(__file__).with_name("stable-lower-probe.py")
)
stable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stable)


def inside(args):
    assert os.getuid() != 0
    assert os.readlink("/proc/self/ns/mnt") != args.host_namespace
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    source = args.root / "source"
    source.mkdir()
    (source / "module.py").write_text("a = 1\nb = 2\n")
    (source / ".git").mkdir()
    (source / ".git" / "sentinel").write_text("fixture")
    lowers = []
    mounts = []
    sessions = {}
    report = {"passed": False, "sameUid": os.getuid(), "lowerReady": []}

    def create_view(label):
        private = args.root / label
        private.mkdir()
        for name in ("control", "lower", "upper", "work", "view"):
            (private / name).mkdir()
        lower = stable.Process([
            str(args.helper), str(source), str(private / "control"),
            str(private / "lower"),
        ])
        lowers.append(lower)
        options = ",".join([
            f"lowerdir={private / 'lower'}", f"upperdir={private / 'upper'}",
            f"workdir={private / 'work'}", "userxattr",
        ])
        subprocess.run([
            "mount", "-t", "overlay", "overlay", "-o", options,
            str(private / "view"),
        ], check=True)
        mounts.append(private / "view")
        sessions[label] = (private, lower)
        return private, lower

    def seal(label):
        seal_id = str(uuid.uuid4())
        result = sessions[label][1].request("seal " + seal_id)
        assert result["state"] == "sealed" and result["valid"], result
        return seal_id

    def command(probe):
        return [
            "setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all",
            str(args.node), str(probe), str(args.root), str(args.sdk), str(args.bundle),
        ]

    try:
        for label in ("A", "B"):
            private, lower = create_view(label)
            report["lowerReady"].append(lower.ready)
            assert (private / "view" / "module.py").exists()

        subprocess.run(command(args.probe), check=True, timeout=120)
        report["runtime"] = json.loads((args.root / "runtime-report.json").read_text())
        assert report["runtime"]["passed"]
        for lower in lowers:
            assert lower.request("verify")["valid"]
        if args.publish_probe:
            (args.root / "seals.json").write_text(json.dumps({label: seal(label) for label in ("A", "B")}))
            publisher = stable.Process(command(args.publish_probe))
            try:
                publisher.send("start")
                while True:
                    request = publisher.receive()
                    action = request["action"]
                    if action == "done":
                        break
                    response = {"id": request["id"], "ok": True}
                    if action == "mount":
                        assert len(request["files"]) == 1
                        file, content = request["files"][0]
                        assert file == "module.py" and isinstance(content, str)
                        value = base64.b64decode(content, validate=True)
                        assert len(value) <= 2 * 1024 * 1024
                        label = "candidate-" + str(uuid.uuid4())
                        private, _ = create_view(label)
                        (private / "view" / file).write_bytes(value)
                        response.update(label=label, workspace=str(private / "view"), control=str(private / "control"))
                    elif action == "seal":
                        response["sealId"] = seal(request["label"])
                    elif action == "close":
                        label = request["label"]
                        assert label.startswith("candidate-")
                        private, lower = sessions.pop(label)
                        subprocess.run(["umount", str(private / "view")], check=True, timeout=10)
                        mounts.remove(private / "view")
                        lower.close()
                        lowers.remove(lower)
                    else:
                        raise AssertionError("Unknown publication fixture action")
                    publisher.send(json.dumps(response))
            finally:
                publisher.close()
            report["publication"] = json.loads((args.root / "publication-report.json").read_text())
            assert report["publication"]["passed"]
        report["passed"] = True
    finally:
        report["cleanUnmount"] = False
        try:
            for mount in reversed(mounts):
                subprocess.run(["umount", str(mount)], check=True, timeout=10)
            for lower in reversed(lowers):
                lower.close()
            report["cleanUnmount"] = True
        finally:
            report["passed"] = report["passed"] and report["cleanUnmount"]
            (args.root / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    for name in ("helper", "node", "probe", "sdk", "bundle"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--publish-probe", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--host-namespace")
    args = parser.parse_args()
    assert all(getattr(args, name).is_absolute() for name in ("helper", "node", "probe", "sdk", "bundle"))
    if args.inside:
        inside(args)
        return
    parent = Path.home() / "codeatelier-native-overlay-probes"
    root = Path(tempfile.mkdtemp(prefix="sandbox-", dir=parent))
    child = subprocess.run([
        "unshare", "--user", "--map-current-user", "--mount", "--keep-caps",
        sys.executable, "-B", str(Path(__file__).resolve()), *sys.argv[1:],
        "--inside", "--root", str(root),
        "--host-namespace", os.readlink("/proc/self/ns/mnt"),
    ])
    mounts = Path("/proc/self/mountinfo").read_text()
    assert str(root) not in mounts, "Experimental mounts propagated to host"
    print(json.dumps({"report": str(root / "report.json"), "exitCode": child.returncode}), flush=True)
    raise SystemExit(child.returncode)


if __name__ == "__main__":
    main()

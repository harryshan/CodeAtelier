# 手动验证正常卸载后内核工作目录的有限权限恢复，配合 backend-probe 的真实删除候选。
# 1. 载入当前 launcher，在独占临时目录模拟 mode-000 的 work/work 和内部残留文件。
# 2. 核对仅该目录变为 owner 0700，内容不删除；链接、错误父身份和未知 mode 拒绝且不改变目标。
# 3. 报告与夹具保留；不挂载、不模拟 Runtime 排空证明、不对用户目录修复 ACL。
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile

spec = importlib.util.spec_from_file_location(
    "overlay_launcher", Path(__file__).resolve().parents[2] / "native/linux-local-overlay/launcher.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def refused(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError("Expected identity/type/mode rejection")


parent = Path.home() / "codeatelier-native-overlay-probes"
parent.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix="work-", dir=parent))
private = root / "private"
work = private / "work"
internal = work / "work"
internal.mkdir(parents=True)
(internal / "retained").write_text("kernel private fixture")
os.chmod(internal, 0)
identity = launcher.directory(work)
launcher.prepare_closed_workdir(private, identity)
assert stat.S_IMODE(internal.stat().st_mode) == 0o700
assert (internal / "retained").read_text() == "kernel private fixture"

os.chmod(internal, 0o500)
refused(lambda: launcher.prepare_closed_workdir(private, identity))
assert stat.S_IMODE(internal.stat().st_mode) == 0o500
os.chmod(internal, 0)
refused(lambda: launcher.prepare_closed_workdir(private, "0:0"))
assert stat.S_IMODE(internal.stat().st_mode) == 0

outside = root / "outside"
outside.mkdir(mode=0o500)
link_private = root / "link-private"
(link_private / "work").mkdir(parents=True)
(link_private / "work/work").symlink_to(outside, target_is_directory=True)
refused(lambda: launcher.prepare_closed_workdir(link_private, launcher.directory(link_private / "work")))
assert stat.S_IMODE(outside.stat().st_mode) == 0o500
result = dict(passed=True, ownerModeRestored=True, contentsRetained=True,
              unknownModeRefused=True, parentReplacementRefused=True, linkRefused=True)
(root / "report.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(dict(root=str(root), **result)), flush=True)

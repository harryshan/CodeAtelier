# Linux Local overlay 的显式 namespace 启动器及固定挂载控制协议。
# 1. main 只接受预装 helper、私有控制根和服务 argv，unshare 保留当前 UID 创建独占 namespace。
# 2. Controller 用私有 Unix socket 接收 UUID 绑定的 open/seal/close/release；目录从控制根派生，
#    来源只读 helper 按需捕获基线，内核 OverlayFS 处理 copy-up，不解释 shell 或客户端挂载参数。
# 3. Lower 管理本进程创建的 helper、有限响应和退出；活跃视图先持久标记再挂载，
#    只有明确 close 的普通卸载和 helper 退出都成功才变为 ready，未知状态拒绝重用。
#    普通 close 后仅恢复已核对的内核 work/work owner 权限，供 Broker 清理候选；不递归修权限。
#    release 仅在卸载后复核所选 upper 摘要/whiteout，逐项删除覆盖；失败保持 active。
#    classify 只查正常卸载 upper 中的明确路径类型/stamp，识别 whiteout，不读正文或修改状态。
# 4. serve 通过 setpriv 撤销服务全部 capabilities，转发退出信号；服务重载仍在同一 namespace。
#    服务异常退出仅尝试卸载，不清除 active；不强制卸载、不恢复未知任务、不删除私有内容。
# 5. 控制协议不是同 UID 的安全边界；真实 Sandbox 必须隐藏控制根/socket，不能把宿主测试当隔离验收。
# Python 3、unshare、setpriv、mount、fusermount3 和预构建只读 helper 为显式前置条件，无自动安装。

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid


def persist(file, value):
    temporary = file.with_name(file.name + "." + str(uuid.uuid4()))
    with temporary.open("x", encoding="utf8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(file)
    descriptor = os.open(file.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def directory(file):
    info = file.lstat()
    if not stat.S_ISDIR(info.st_mode) or file.resolve() != file:
        raise ValueError("DIRECTORY_IDENTITY")
    return f"{info.st_dev}:{info.st_ino}"


def prepare_closed_workdir(private, expected):
    # 内核会为 whiteout 等操作留下 mode-000 的 work/work；此时视图已卸载、helper 已退出。
    # 只处理固定名字、匹配父身份且属于当前 UID 的普通目录；不沿链接或触及 upper/来源。
    work = private / "work"
    if directory(work) != expected:
        raise ValueError("WORK_REPLACED")
    internal = work / "work"
    try:
        before = internal.lstat()
    except FileNotFoundError:
        return
    if (not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) not in (0, 0o700)):
        raise ValueError("WORK_INTERNAL_TYPE")
    os.chmod(internal, 0o700, follow_symlinks=False)
    after = internal.lstat()
    if (before.st_dev != after.st_dev or before.st_ino != after.st_ino
            or before.st_uid != after.st_uid or not stat.S_ISDIR(after.st_mode)):
        raise ValueError("WORK_INTERNAL_REPLACED")


class Lower:
    def __init__(self, helper, source, control, target):
        self.process = subprocess.Popen(
            [str(helper), str(source), str(control), str(target)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        try:
            self.ready = self.receive()
            if self.ready.get("state") != "ready" or not self.ready.get("valid"):
                raise RuntimeError("LOWER_NOT_READY")
        except BaseException:
            self.abort()
            raise

    def receive(self):
        deadline = time.monotonic() + 20
        while b"\n" not in self.buffer:
            if not self.selector.select(max(0, deadline - time.monotonic())):
                raise TimeoutError("LOWER_TIMEOUT")
            value = os.read(self.process.stdout.fileno(), 4096)
            if not value or len(self.buffer) + len(value) > 65536:
                raise RuntimeError("LOWER_PROTOCOL")
            self.buffer += value
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def request(self, command):
        self.process.stdin.write((command + "\n").encode())
        self.process.stdin.flush()
        return self.receive()

    def abort(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        self.process.stdin.close()
        self.process.stdout.close()
        self.selector.close()

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.stdin.write(b"close\n")
                self.process.stdin.flush()
            if self.process.wait(timeout=10) != 0:
                raise RuntimeError("LOWER_EXIT")
        finally:
            self.abort()


class Controller:
    def __init__(self, root, helper, views=None):
        self.root = root
        self.helper = helper
        self.workspace_root = views
        self.views = {}
        self.poisoned = False

    def workspace(self, identity):
        if self.workspace_root:
            return self.workspace_root / identity
        return self.root / identity / "view"

    def dispatch(self, request):
        if not isinstance(request, dict) or request.get("version") != 1:
            raise ValueError("PROTOCOL_VERSION")
        operation = request.get("operation")
        if operation == "hello":
            return {"namespace": os.readlink("/proc/self/ns/mnt"), "pid": os.getpid()}
        if self.poisoned:
            raise RuntimeError("CONTROLLER_UNKNOWN")
        identity = str(uuid.UUID(request["id"]))
        if identity != request["id"]:
            raise ValueError("VIEW_ID")
        if operation == "open":
            return self.open(identity, request)
        if operation == "seal":
            seal = str(uuid.uuid4())
            value = self.views[identity][1].request("seal " + seal)
            if value.get("state") != "sealed" or not value.get("valid"):
                raise RuntimeError("SEAL_FAILED")
            return {"sealId": seal}
        if operation == "close":
            self.close(identity, clean=True)
            return {}
        if operation == "release":
            return self.release(identity, request["remove"])
        if operation == "classify":
            return self.classify(identity, request["paths"])
        raise ValueError("UNKNOWN_OPERATION")

    def classify(self, identity, paths):
        if identity in self.views or not isinstance(paths, list) or not 1 <= len(paths) <= 100:
            raise ValueError("REVIEW_NOT_CLOSED_OR_LIMIT")
        private = self.root / identity
        directory(private)
        record_file = private / "mount.json"
        info = record_file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError("MOUNT_RECORD_INVALID")
        record = json.loads(record_file.read_text())
        upper = private / "upper"
        upper_identity = directory(upper)
        if (record.get("version") != 1 or record.get("phase") != "ready"
                or upper_identity != record["directories"]["upper"]):
            raise ValueError("REVIEW_NOT_READY")
        files = []
        total = 0
        for relative in paths:
            if not isinstance(relative, str):
                raise ValueError("REVIEW_PATH")
            total += len(relative.encode("utf8"))
            parts = relative.split("/")
            if (total > 16384 or any(part in ("", ".", "..", ".git", ".hg", ".svn")
                                    or "\\" in part or "\x00" in part for part in parts)):
                raise ValueError("REVIEW_PATH")
            target = upper
            for part in parts[:-1]:
                target = target / part
                directory(target)
                attributes = os.listxattr(target, follow_symlinks=False)
                if ("user.overlay.redirect" in attributes
                        or ("user.overlay.opaque" in attributes
                            and os.getxattr(target, "user.overlay.opaque", follow_symlinks=False) == b"y")):
                    raise ValueError("REVIEW_ANCESTOR_UNSUPPORTED")
            target = target / parts[-1]
            info = target.lstat()
            attributes = os.listxattr(target, follow_symlinks=False)
            deleted = stat.S_ISCHR(info.st_mode) and info.st_rdev == 0
            if "user.overlay.whiteout" in attributes:
                if not stat.S_ISREG(info.st_mode) or info.st_size != 0:
                    raise ValueError("REVIEW_WHITEOUT_INVALID")
                deleted = os.getxattr(target, "user.overlay.whiteout", follow_symlinks=False) == b"y"
                if not deleted:
                    raise ValueError("REVIEW_WHITEOUT_INVALID")
            # 内核可在多个删除路径/工作缓存间硬链接同一个 whiteout。
            # 删除标记没有可共享改写的正文，普通文件仍必须单链接。
            if ((not deleted and (info.st_nlink != 1 or not stat.S_ISREG(info.st_mode)
                    or info.st_size > 2 * 1024 * 1024))
                    or "user.overlay.metacopy" in attributes):
                raise ValueError("REVIEW_FILE_UNSUPPORTED")
            current = target.lstat()
            def stamp(value):
                return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{value.st_mtime_ns}:{value.st_ctime_ns}:{value.st_mode}"
            if stamp(info) != stamp(current):
                raise ValueError("REVIEW_FILE_CHANGED")
            files.append({"path": relative, "stamp": stamp(info), "deleted": deleted})
        return {"source": record["source"], "sourceIdentity": record["sourceIdentity"],
                "upperIdentity": upper_identity, "files": files}

    def release(self, identity, items):
        if identity in self.views or not isinstance(items, list) or len(items) > 100:
            raise ValueError("RELEASE_NOT_CLOSED")
        private = self.root / identity
        directory(private)
        record = json.loads((private / "mount.json").read_text())
        if record.get("phase") != "ready":
            raise ValueError("RELEASE_NOT_READY")
        upper = private / "upper"
        if directory(upper) != record["directories"]["upper"]:
            raise ValueError("UPPER_REPLACED")
        targets = []
        for item in items:
            relative = item["path"]
            parts = relative.split("/")
            if (not parts or any(part in ("", ".", "..", ".git", ".hg", ".svn")
                                 or "\\" in part or "\x00" in part for part in parts)):
                raise ValueError("RELEASE_PATH")
            target = upper
            for part in parts[:-1]:
                target = target / part
                directory(target)
            target = target / parts[-1]
            info = target.lstat()
            if target in targets:
                raise ValueError("RELEASE_DUPLICATE_OR_LINK")
            expected = item["contentDigest"]
            if expected is None:
                whiteout = stat.S_ISCHR(info.st_mode) and info.st_rdev == 0
                if stat.S_ISREG(info.st_mode) and info.st_size == 0:
                    whiteout = os.getxattr(target, "user.overlay.whiteout") == b"y"
                if not whiteout:
                    raise ValueError("RELEASE_WHITEOUT")
            elif (info.st_nlink != 1 or not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024
                    or hashlib.sha256(target.read_bytes()).hexdigest() != expected):
                raise ValueError("RELEASE_CHANGED")
            targets.append(target)
        record["phase"] = "active"
        persist(private / "mount.json", record)
        for target in targets:
            target.unlink()
        record["phase"] = "ready"
        persist(private / "mount.json", record)
        return {"removed": len(targets)}

    def open(self, identity, request):
        if identity in self.views or len(self.views) >= 16:
            raise ValueError("VIEW_BUSY_OR_LIMIT")
        source = Path(request["source"])
        if not source.is_absolute():
            raise ValueError("SOURCE_PATH")
        source_identity = directory(source)
        if (source == self.root or source in self.root.parents
                or self.root in source.parents):
            raise ValueError("SOURCE_CONTROL_OVERLAP")
        if self.workspace_root and (source == self.workspace_root
                or source in self.workspace_root.parents
                or self.workspace_root in source.parents):
            raise ValueError("SOURCE_VIEW_OVERLAP")
        private = self.root / identity
        workspace = self.workspace(identity)
        paths = {name: private / name for name in ("lower", "upper", "work")}
        paths["view"] = workspace
        create = request.get("create")
        if not isinstance(create, bool):
            raise ValueError("CREATE_REQUIRED")
        if create:
            private.mkdir(mode=0o700)
            for target in paths.values():
                target.mkdir(mode=0o700)
            record = {
                "version": 1, "source": str(source),
                "sourceIdentity": source_identity,
            }
        else:
            directory(private)
            record = json.loads((private / "mount.json").read_text())
            if (record.get("phase") != "ready"
                    or record.get("source") != str(source)
                    or record.get("sourceIdentity") != source_identity):
                raise ValueError("VIEW_NOT_READY")
            for name, target in paths.items():
                if directory(target) != record["directories"][name]:
                    raise ValueError("VIEW_REPLACED")
        record["phase"] = "active"
        record["directories"] = {
            name: directory(target) for name, target in paths.items()
        }
        persist(private / "mount.json", record)
        control = private / ("control-" + str(uuid.uuid4()))
        control.mkdir(mode=0o700)
        lower = Lower(self.helper, source, control, private / "lower")
        self.views[identity] = (private, lower, record, False)
        options = ",".join([
            f"lowerdir={private / 'lower'}", f"upperdir={private / 'upper'}",
            f"workdir={private / 'work'}", "userxattr", "index=off",
            "metacopy=off", "redirect_dir=nofollow",
        ])
        subprocess.run([
            "mount", "-t", "overlay", "overlay", "-o", options,
            str(workspace),
        ], check=True, timeout=20)
        self.views[identity] = (private, lower, record, True)
        return {
            "workspace": str(workspace), "control": str(control),
            "upper": str(private / "upper"), "ready": lower.ready,
            "backingIdentity": record["directories"]["view"],
        }

    def close(self, identity, clean):
        private, lower, record, mounted = self.views[identity]
        if mounted:
            subprocess.run(
                ["umount", str(self.workspace(identity))], check=True, timeout=10,
            )
        lower.close()
        del self.views[identity]
        if clean:
            prepare_closed_workdir(private, record["directories"]["work"])
            record["phase"] = "ready"
            persist(private / "mount.json", record)

    def shutdown(self):
        success = not self.views and not self.poisoned
        for identity in list(self.views):
            try:
                self.close(identity, clean=False)
            except BaseException:
                success = False
        return success


def receive(connection):
    connection.settimeout(20)
    value = b""
    while b"\n" not in value:
        chunk = connection.recv(4096)
        if not chunk or len(value) + len(chunk) > 65536:
            raise ValueError("REQUEST_LIMIT")
        value += chunk
    if value.count(b"\n") != 1 or not value.endswith(b"\n"):
        raise ValueError("ONE_REQUEST_REQUIRED")
    return json.loads(value)


def serve(args):
    if (os.getuid() == 0
            or os.readlink("/proc/self/ns/mnt") == args.host_namespace):
        raise RuntimeError("PRIVATE_NAMESPACE_REQUIRED")
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    root = args.root.resolve()
    if any(char in str(root) for char in (",", ":", "\\", "\n")):
        raise ValueError("MOUNT_PATH")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory(root)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError("PRIVATE_CONTROL_ROOT_REQUIRED")
    with (root / "controller.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        endpoint = root / "controller.sock"
        if endpoint.exists():
            if not stat.S_ISSOCK(endpoint.lstat().st_mode):
                raise ValueError("SOCKET_TYPE")
            endpoint.unlink()
        views = args.views.resolve() if args.views else None
        if views:
            views.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory(views)
            if (views == root or root in views.parents or views in root.parents
                    or views.stat().st_uid != os.getuid()
                    or views.stat().st_mode & 0o077
                    or any(char in str(views) for char in (",", ":", "\\", "\n"))):
                raise ValueError("PRIVATE_VIEW_ROOT_REQUIRED")
        controller = Controller(root, args.helper.resolve(strict=True), views)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(endpoint))
            os.chmod(endpoint, 0o600)
            server.listen(16)
            server.settimeout(0.25)
            env = dict(os.environ)
            env["CODEATELIER_OVERLAY_SOCKET"] = str(endpoint)
            env["CODEATELIER_OVERLAY_ROOT"] = str(root)
            if views:
                env["CODEATELIER_OVERLAY_VIEWS"] = str(views)
            else:
                env.pop("CODEATELIER_OVERLAY_VIEWS", None)
            child = subprocess.Popen([
                "setpriv", "--inh-caps=-all", "--ambient-caps=-all",
                "--bounding-set=-all",
                *args.command,
            ], env=env)

            def forward(signum, _frame):
                if child.poll() is None:
                    child.send_signal(signum)

            signal.signal(signal.SIGINT, forward)
            signal.signal(signal.SIGTERM, forward)
            try:
                while child.poll() is None:
                    try:
                        connection, _ = server.accept()
                    except TimeoutError:
                        continue
                    with connection:
                        read_only = False
                        try:
                            request = receive(connection)
                            read_only = request.get("operation") == "classify"
                            result = controller.dispatch(request)
                            response = {"version": 1, "ok": True, **result}
                        except (ValueError, KeyError) as error:
                            response = {
                                "version": 1, "ok": False,
                                "reason": type(error).__name__,
                            }
                        except Exception as error:
                            if not read_only:
                                controller.poisoned = True
                            response = {
                                "version": 1, "ok": False,
                                "reason": type(error).__name__,
                            }
                        try:
                            connection.sendall((json.dumps(response) + "\n").encode())
                        except OSError:
                            if not read_only:
                                controller.poisoned = True
            finally:
                clean = controller.shutdown()
                endpoint.unlink()
            return child.wait() if clean else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--views", type=Path)
    parser.add_argument("--host-namespace")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if (not args.command or not args.root.is_absolute()
            or not args.helper.is_absolute()
            or (args.views and not args.views.is_absolute())):
        parser.error("Absolute root/helper and explicit server command required")
    if args.host_namespace:
        raise SystemExit(serve(args))
    os.execvp("unshare", [
        "unshare", "--user", "--map-current-user", "--mount", "--keep-caps",
        sys.executable, str(Path(__file__).resolve()),
        "--host-namespace", os.readlink("/proc/self/ns/mnt"),
        "--root", str(args.root), "--helper", str(args.helper),
        *(["--views", str(args.views)] if args.views else []), "--", *args.command,
    ])


if __name__ == "__main__":
    main()

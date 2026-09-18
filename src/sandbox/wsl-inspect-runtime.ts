/**
 * 通过 Windows 的 WSL2 和 bubblewrap 提供 inspect profile 的 Linux 参考 SandboxRuntime。
 * RuntimeFactory 只在 Windows 且显式开启 Sandbox 时创建本类；SandboxBroker 在每次命令前调用 selfCheck，
 * 随后将已经过审批的 POSIX 命令交给 execute。它依赖 tools/process 负责宿主 wsl.exe 进程树取消、超时、
 * 输出清理与限制，而固定的 WSL 启动脚本负责清空命令环境和建立 Linux 文件系统、进程与网络边界。
 *
 * 1. WSL_INSPECT_LAUNCHER 仅处理固定模式、工作区根和获批命令文本；通过 wslpath 转换 Windows 路径，
 *    以 bubblewrap 建立 user、PID、IPC、UTS、network namespace 和新的 session。
 * 2. 文件系统仅向命令映射只读工作区到 /opt；/mnt、home、root、run、tmp 与 sys 都是私有 tmpfs，/proc 和
 *    /dev 由 bubblewrap 新建。现有 .git 和 .env* 分别遮蔽为临时目录或空设备，避免透露真实受保护内容。
 * 3. selfCheck 在实际后端执行无害探针，验证工作区只读、宿主挂载/home 不可见、环境清空及受保护路径遮蔽；
 *    失败只返回固定说明，不让路径或命令进入公开 Sandbox 状态。
 * 4. execute 只接受 ToolRunner 在 Windows Sandbox 模式下生成的 /bin/sh -c 形状，并复用调用方的取消、
 *    输出和墙钟时间限制。它尚未实现 cgroup/rlimit 资源限制、外部文件或网络例外，不能宣称完成完整 S2。
 */

import { executeProcess } from "../tools/process.js";
import type {
  SandboxCommand,
  SandboxRuntime,
  SandboxWorkspace,
} from "./types.js";

const WSL_EXECUTABLE = "wsl.exe";
const SELF_CHECK_TIMEOUT_MS = 10_000;
const SELF_CHECK_OUTPUT_LIMIT = 1_000;
const INSPECT_LEVEL = "wsl2-bubblewrap-inspect";

type ProcessExecutor = typeof executeProcess;

/**
 * 这个脚本是受信任的固定启动器，不拼接工作区或命令文本。它们都作为 shell 位置参数传递并始终双引号引用，
 * 因此获批命令只能在最终、已隔离的 /bin/sh -c 中解释。
 */
const WSL_INSPECT_LAUNCHER = String.raw`set -eu
mode="$1"
workspace_input="$2"
command_text="$3"
workspace="$(wslpath -au "$workspace_input")"

if [ ! -d "$workspace" ]; then
  exit 70
fi

set -- \
  --unshare-user --uid 0 --gid 0 \
  --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
  --new-session --die-with-parent \
  --ro-bind / / \
  --ro-bind "$workspace" /opt \
  --tmpfs /tmp --tmpfs /var/tmp --tmpfs /home --tmpfs /root --tmpfs /run --tmpfs /mnt --tmpfs /sys \
  --proc /proc --dev /dev

for protected in "$workspace"/.git "$workspace"/.env "$workspace"/.env.*; do
  if [ ! -e "$protected" ] && [ ! -L "$protected" ]; then
    continue
  fi

  name="$(basename "$protected")"
  if [ -d "$protected" ]; then
    set -- "$@" --tmpfs "/opt/$name"
  else
    set -- "$@" --ro-bind /dev/null "/opt/$name"
  fi
done

set -- "$@" \
  --clearenv \
  --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --setenv HOME /nonexistent \
  --setenv TMPDIR /tmp \
  --setenv NO_COLOR 1 \
  --setenv TERM dumb \
  --chdir /opt \
  -- /bin/sh -c

if [ "$mode" = "self-check" ]; then
  exec /usr/bin/bwrap "$@" '
    test -d /opt
    test -z "$(/bin/ls -A /mnt)"
    test -z "$(/bin/ls -A /home)"
    test ! -e /sys/class/net
    test -c /dev/null
    test -z "$(/usr/bin/env | /bin/grep '^CODEATELIER_API_KEY=' || true)"
    if touch /opt/.codeatelier-sandbox-write-probe 2>/dev/null; then
      exit 1
    fi
    if [ -e /opt/.git ]; then
      test ! -e /opt/.git/config
    fi
    for protected in /opt/.env /opt/.env.*; do
      if [ -e "$protected" ]; then
        test ! -s "$protected"
      fi
    done
  '
fi

exec /usr/bin/bwrap "$@" "$command_text"`;

function commandText(command: SandboxCommand) {
  if (
    command.command !== "/bin/sh" ||
    command.args.length !== 2 ||
    command.args[0] !== "-c"
  ) {
    throw new Error("WSL inspect runtime 只接受固定的 POSIX shell 命令形状。");
  }

  return command.args[1];
}

export class WslInspectRuntime implements SandboxRuntime {
  constructor(private runProcess: ProcessExecutor = executeProcess) {}

  private async run(
    mode: "self-check" | "execute",
    workspace: SandboxWorkspace,
    signal: AbortSignal,
    timeoutMs: number,
    outputLimit: number,
    onOutput: (text: string) => void,
    command = "",
  ) {
    return this.runProcess(
      WSL_EXECUTABLE,
      [
        "--exec",
        "/bin/sh",
        "-c",
        WSL_INSPECT_LAUNCHER,
        "codeatelier-wsl-inspect",
        mode,
        workspace.root,
        command,
      ],
      process.cwd(),
      signal,
      timeoutMs,
      outputLimit,
      onOutput,
    );
  }

  async selfCheck(signal: AbortSignal, workspace: SandboxWorkspace) {
    try {
      const result = await this.run(
        "self-check",
        workspace,
        signal,
        SELF_CHECK_TIMEOUT_MS,
        SELF_CHECK_OUTPUT_LIMIT,
        () => {},
      );

      if (result.exitCode !== 0 || result.truncated) {
        throw new Error("WSL2 bubblewrap 自检未通过。");
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      throw new Error("WSL2 bubblewrap inspect runtime 不可用或自检未通过。");
    }

    return {
      level: INSPECT_LEVEL,
      workspaceProtection: "direct-path" as const,
    };
  }

  execute(command: SandboxCommand, workspace: SandboxWorkspace) {
    return this.run(
      "execute",
      workspace,
      command.signal,
      command.timeoutMs,
      command.outputLimit,
      command.onOutput,
      commandText(command),
    );
  }
}

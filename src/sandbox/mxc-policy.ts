/**
 * 将 Broker 已规范化的授权根转换为固定 MXC v1 POSIX 策略；不读取模型参数或宿主环境。
 * 1. mxcExecutionMode 为 Linux/Bubblewrap 和 macOS/Seatbelt 提供真实执行归因。
 * 2. assertDisjointRoots 拒绝工作区/额外授权覆盖 Broker 数据或实例只读代码，避免父目录授权吞掉边界。
 * 3. createMxcRequest 仅启动固定 Node/bundle；私有 HOME/tmp、清空环境、双向断网、禁用 Mac GUI/Keychain/PTY。
 * 不配置总运行期限，不启动 shell 工具，不把统一策略类型视为两平台相同的 OS 保证。
 */

import path from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";

export type MxcPlatform = "linux" | "darwin";

export function mxcExecutionMode(platform: MxcPlatform) {
  return platform === "linux" ? "linux-bubblewrap" : "macos-seatbelt";
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertDisjointRoots(
  granted: string[],
  protectedRoots: string[],
) {
  if (
    granted.some((root) =>
      protectedRoots.some(
        (protectedRoot) =>
          contains(root, protectedRoot) || contains(protectedRoot, root),
      ),
    )
  ) {
    throw new Error("MXC 授权根与 Broker 数据或 Runtime 私有目录重叠。");
  }
}

export function createMxcRequest(input: {
  platform: MxcPlatform;
  workspace: string;
  node: string;
  code: string;
  home: string;
  temporary: string;
  brokerData: string;
  readRoots: string[];
  writeRoots: string[];
}): ContainerRequest {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  return {
    containment:
      input.platform === "linux"
        ? { type: "bubblewrap" }
        : {
            type: "seatbelt",
            config: {
              guiAccess: false,
              keychainAccess: false,
              nestedPty: false,
              extraMachLookups: [],
            },
          },
    command: `exec ${quote(input.node)} ${quote(path.join(input.code, "agent-runtime.mjs"))}`,
    workingDirectory: input.workspace,
    filesystem: {
      readonlyPaths: [input.code, ...input.readRoots],
      readwritePaths: [
        input.workspace,
        input.home,
        input.temporary,
        ...input.writeRoots,
      ],
      deniedPaths: [input.brokerData],
    },
    environment: {
      HOME: input.home,
      TMPDIR: input.temporary,
      TMP: input.temporary,
      TEMP: input.temporary,
      PATH: `${path.dirname(input.node)}:/usr/local/bin:/usr/bin:/bin`,
      LANG: "C.UTF-8",
    },
    inheritDefaultEnvironment: false,
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    timeoutMs: 0,
  };
}

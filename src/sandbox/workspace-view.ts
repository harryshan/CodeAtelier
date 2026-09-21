/**
 * 为 SandboxBroker 和平台 SandboxRuntime 定义真实工作区的最小受限视图。
 * Broker 仅在启用 Sandbox 后创建本视图，并将 descriptor 交给 Runtime 自检与执行；Runtime 必须在
 * 文件系统边界实际落实 descriptor 的受保护路径规则，不能把本类的路径检查当作 OS 级隔离替代。
 *
 * 1. WorkspaceView.open 规范化并确认作为命令 cwd 的工作区根目录存在且为目录。
 * 2. descriptor 提供真实根目录及声明的保护等级，供迁移期 Runtime 建立受限挂载或 ACL；最终 Windows
 *    Runtime 使用 AccessManifest。工作区内 `.git`、`.env` 与普通路径相同，不施加额外保护。
 * 3. resolveDirectPath 供 Runtime 适配器和集成测试在任何实际访问前重新核对候选路径，拒绝工作区外
 *    和解析链接后的逃逸；它有意不承诺祖先目录操作或硬链接等别名防护。
 *
 * 错误消息不包含用户输入或宿主绝对路径，以免被工具历史、任务事件或 trace 意外暴露。现行 Windows
 * Runtime 把本描述符作为 preflight 输入，再以 AccessManifest/原生对象身份落实权限；本类本身不构成隔离。
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonical, inside } from "../tools/paths.js";
import type { SandboxWorkspace } from "./types.js";

export class SandboxWorkspaceError extends Error {
  readonly code = "SANDBOX_WORKSPACE_REJECTED";

  constructor(reason: string) {
    super(`Sandbox 工作区视图拒绝访问：${reason}`);
    this.name = "SandboxWorkspaceError";
  }
}

export class WorkspaceView {
  private constructor(readonly root: string) {}

  static async open(root: string) {
    let canonicalRoot: string;

    try {
      canonicalRoot = await realpath(root);
      const info = await stat(canonicalRoot);

      if (!info.isDirectory()) {
        throw new SandboxWorkspaceError("工作区根目录不是目录。");
      }
    } catch (error) {
      if (error instanceof SandboxWorkspaceError) {
        throw error;
      }

      throw new SandboxWorkspaceError("工作区根目录不可用。");
    }

    return new WorkspaceView(canonicalRoot);
  }

  descriptor(): SandboxWorkspace {
    return {
      root: this.root,
      protectedPaths: [],
      protection: "direct-path",
    };
  }

  /**
   * 供实际 Runtime 在打开文件、建立映射或处理文件型参数前复核。受保护项的父目录仍可列名，
   * 所以本函数只承诺直接目标，不把祖先改名、删除或硬链接误报为已防护。
   */
  async resolveDirectPath(input: string) {
    if (input.includes("\0")) {
      throw new SandboxWorkspaceError("路径包含非法字符。");
    }

    const lexical = path.resolve(this.root, input);

    if (!inside(this.root, lexical)) {
      throw new SandboxWorkspaceError("目标位于工作区外。");
    }

    let resolved: string;

    try {
      resolved = await canonical(lexical);
    } catch {
      throw new SandboxWorkspaceError("目标无法规范化。");
    }

    if (!inside(this.root, resolved)) {
      throw new SandboxWorkspaceError("目标经链接解析后位于工作区外。");
    }

    return resolved;
  }
}

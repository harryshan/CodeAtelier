/**
 * 组合 Sandbox 实例 Git global 配置；仅由 Windows/MXC 的 Broker 启动准备调用。
 * 1. sandboxGitConfig 先生成当前工作目录信任，再读取宿主 Git 对该工作目录解析的 name/email。
 * 2. 白名单序列化只写 user.name/email，不复制 include、认证、签名或其它宿主配置。
 * 3. 无仓库仍可携带提交身份，便于任务内初始化项目；已有 safe.directory 规则不扩大。
 * 返回文本交给调用方独占落盘和清理。原配置不变，身份只存在实例文件，不写日志/trace。
 */

import { readHostGitIdentity } from "./host-git-identity.js";
import {
  quoteGitConfigValue,
  workspaceGitConfig,
} from "./git-workspace-trust.js";

export async function sandboxGitConfig(
  workspace: string,
  options: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const trust = await workspaceGitConfig(workspace);
  const identity = await readHostGitIdentity(
    workspace,
    options.environment,
    options.signal,
  );
  const fields: string[] = [];
  if (identity.name !== undefined) {
    fields.push(`\tname = ${quoteGitConfigValue(identity.name)}\n`);
  }

  if (identity.email !== undefined) {
    fields.push(`\temail = ${quoteGitConfigValue(identity.email)}\n`);
  }

  return trust + (fields.length ? `[user]\n${fields.join("")}` : "");
}

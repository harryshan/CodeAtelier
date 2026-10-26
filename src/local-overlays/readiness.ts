/**
 * 隔离 Local 的代码级总开关，供 Engine、HTTP 路由和显式启动器共同使用。
 * 1. 默认关闭；只能修改此常量并重新构建/启动，不读取 settings、环境变量或请求参数。
 * 2. requireLocalOverlayEnabled 在创建执行或发布前拒绝进入功能；UI 从 bootstrap 获取同一决定。
 * 3. 不阻止历史读取、任务取消、关闭卸载或旧 Sandbox 授权撤销，不删除或迁移私有数据。
 * 此开关不控制普通 Local、Riftri、Git worktree 或 Sandbox；开启后仍须满足平台和 Sandbox 前提。
 * 无运行时状态变化；拒绝沿用入口的错误/trace，不记录路径或源码，也不启动原生后端。
 */
export const LOCAL_OVERLAY_ENABLED = false;

export const LOCAL_OVERLAY_DISABLED_REASON =
  "隔离 Local 功能已关闭；已有历史和私有修改保留，暂不能执行、检查或发布。";

export function requireLocalOverlayEnabled() {
  if (!LOCAL_OVERLAY_ENABLED) {
    throw new Error(LOCAL_OVERLAY_DISABLED_REASON);
  }
}

/**
 * 统一 Windows Sandbox 的原生 ACL 清理与外层恢复期限，供 Broker 和原生适配器共用。
 * 大目录的可继承 ACL 更新可能持续数分钟，不能套用安装自检的短命令期限。
 *
 * 1. WINDOWS_ACL_CLEANUP_TIMEOUT_MS 限制一次共享根撤权或 journal 对账。
 * 2. WINDOWS_RECOVERY_TIMEOUT_MS 为账户排空、ACL 对账和安装自检预留总预算。
 * 期限到达仍保留 unknown 与 journal，不改变撤权内容，也不授权宿主重放。
 */

export const WINDOWS_ACL_CLEANUP_TIMEOUT_MS = 10 * 60_000;
export const WINDOWS_RECOVERY_TIMEOUT_MS =
  WINDOWS_ACL_CLEANUP_TIMEOUT_MS + 60_000;

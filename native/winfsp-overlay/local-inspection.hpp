// Local 私有层离线检查的进程证明接口，由 main 在 Store 的服务与正常收尾前后调用。
// 1. recordLocalMount 在独占 mount.lock 上记录当前 helper/宿主身份；不用于来源发布租约。
// 2. closeLocalMount 仅在 dispatcher 与 Store 已正常收尾后标记 closed。
// 3. inspectLocal 持有旧 mount.lock 并验证旧进程退出，提供只读检查会话，不挂载或修复数据库。
// 4. verifyLocalStopped 在已持有的排他句柄上重核旧进程，供只恢复根 ACL 的原生入口使用。
// 无记录/身份未知拒绝；该证明不是 Sandbox 后代进程排空证明。
#pragma once
#include "store.hpp"

namespace overlay {
void recordLocalMount(HANDLE file, DWORD owner);
void closeLocalMount(HANDLE file);
void verifyLocalStopped(HANDLE file);
void inspectLocal(const fs::path& control);
}  // namespace overlay

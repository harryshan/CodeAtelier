// 持久发布 helper 的会话入口，由 main 固定参数分流调用。
// 1. publicationSession 持有来源协调目录中的排他句柄并串行执行发布命令。
// 2. inspection 模式核对旧 generation/进程终止，保持排他供审核，仅可按哈希删除固定协调锁。
// 3. 返回前关闭句柄；只有显式 finish 写 closed，EOF/强杀保留 active 供恢复检查。
// 不安装驱动、不提升权限；这不是对任意宿主写者的文件系统安全边界。
#pragma once
#include <string>

namespace overlay {
void publicationSession(const std::wstring& gate, const std::wstring& generation,
                        unsigned long owner, bool inspection);
}

// Windows 发布命令接口，由 overlay helper 的短生命周期 CLI 调用。
// 1. publishReplace 复核当前/候选内容，保留 owner/group/DACL，原生替换并返回备份身份。
// 2. publishCleanup 仅删除身份与内容均匹配的同批次备份；未知状态不自动调用。
// 3. publishStage 只提供固定诊断编号，错误收据不含路径、内容或安全描述符。
// 4. publishCreate/Delete 为持租约会话提供有界内容核对和不覆盖新建/按句柄删除。
// 不创建挂载、不安装组件、不提升权限；普通 OS 权限与宿主发布日志共同约束副作用。
#pragma once

#include <string>

namespace overlay {
unsigned publishStage();
std::wstring publishReplace(const std::wstring& target, const std::wstring& temporary,
                            const std::wstring& beforeHash, const std::wstring& afterHash);
void publishCleanup(const std::wstring& backup, const std::wstring& identity,
                    const std::wstring& expectedHash);
void publishCreate(const std::wstring& target, const std::wstring& temporary,
                   const std::wstring& afterHash);
void publishDelete(const std::wstring& target, const std::wstring& beforeHash);
}  // namespace overlay

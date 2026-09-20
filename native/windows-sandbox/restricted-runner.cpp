/**
 * 构建 CodeAtelier Windows Sandbox 的 restricted-token/Job bootstrap 可执行文件。
 * 当前复用已经通过专用账户并发写根夹具的 Win32 实现，供产品 supervisor 接入前保持唯一的 token 算法来源。
 *
 * 1. bootstrap 从专用账户 token 创建 WRITE_RESTRICTED primary token。
 * 2. 每实例 execution/root capability、显式 default DACL 与 KILL_ON_JOB_CLOSE Job 在同一实现中建立。
 * 3. 现有探针入口继续用于安装后的平台验收；产品命令执行入口由 supervisor 后续固定协议调用。
 *
 * 本包装文件本身不扩大探针的命令行能力，也不表示仅构建二进制就已启用产品 Sandbox。
 */

#include "../../experiments/windows-restricted-token-demo/restricted_token_demo.cpp"


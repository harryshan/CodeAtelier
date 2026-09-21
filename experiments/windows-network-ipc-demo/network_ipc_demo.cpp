/*
 * 为 Windows 网络与 Broker IPC 可行性探针启用 native 共用实现的完整实验命令面。
 * run-demo.ps1 编译本文件；产品构建不经过该包装，而对同一实现定义
 * CODEATELIER_PRODUCT_WFP_ONLY，只保留持久 WFP install/verify/remove。
 *
 * 1. 共用实现保存已验证的 SID、WFP、网络、Named Pipe 与 relay 夹具。
 * 2. 本包装不新增产品能力，也不把实验结果提升为产品验收。
 * 3. 产品与探针共用一份 WFP 规则/GUID 实现，避免复制后版本漂移。
 */

#include "../../native/windows-sandbox/network-fence-implementation.cpp"

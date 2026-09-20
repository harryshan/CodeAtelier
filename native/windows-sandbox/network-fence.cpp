/**
 * 构建 CodeAtelier Windows Sandbox 的持久 WFP fence 管理可执行文件。
 * 当前复用已经过真实管理员环境验证的 network/IPC 探针实现；产品安装脚本只调用其中固定的
 * --wfp-persistent-install、--wfp-persistent-verify 和 --wfp-persistent-remove 入口。
 *
 * 1. install 按专用账户 SID 安装固定 provider/sublayer 下的 V4/V6 connect、listen 与 raw 规则。
 * 2. verify 枚举并核对八条持久规则，不把“进程成功退出”误当成规则存在。
 * 3. remove 只删除该实现固定 GUID 名下的对象，重复调用为空操作。
 *
 * 后续把共享实现移入 native 库时保留这些命令行入口和 GUID，避免升级遗留旧规则。
 */

#include "../../experiments/windows-network-ipc-demo/network_ipc_demo.cpp"


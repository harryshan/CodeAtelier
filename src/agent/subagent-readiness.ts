/*
 * 可选 subagent 对外发布门禁，由任务路由、Engine 和 bootstrap 共同使用。
 *
 * 1. D158 按用户要求开放任务级试用入口；true 表示 UI/API 可选择，不表示全部平台验收通过。
 * 2. 每个新任务仍默认关闭，启用值随任务保存；关闭发布门禁时 HTTP/Engine 继续拒绝 true。
 * 3. bootstrap 使用相同常量决定是否展示复选框；取消与恢复沿用保存值，不读取当前草稿。
 *
 * 入口开放不改变只读工具、Sandbox 权限或安装版本检查；构建/harness 不构成真实安装态验收。
 */

export const SUBAGENT_PUBLIC_READY = true;

/*
 * 可选 subagent 对外发布门禁，由任务路由、Engine 和 bootstrap 共同使用。
 *
 * 1. 只有双执行路径、持久化/取消/恢复以及专用账户提升环境验收全部完成后才允许改为 true。
 * 2. 默认关闭时，即使浏览器伪造 bootstrap 或直接调用 API，服务端仍拒绝启用子任务。
 * 3. 内部标记任务的 Store/Worker/Runtime harness 不依赖该门禁，可继续独立验证实现。
 *
 * 不提供环境变量或请求参数绕过；构建成功及 stdio harness 不构成真实 Sandbox 验收。
 */

export const SUBAGENT_PUBLIC_READY = false;

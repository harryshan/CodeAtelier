/**
 * Web 统计入口，复用服务端与迁移验证器共用的纯统计实现。
 * 1. 重导出事件 reducer / 展示统计，不引入数据库或平台依赖。
 * 2. 旧组件和测试继续从本路径导入；算法的唯一实现在 shared 中。
 */
export * from "../shared/session-event-statistics.js";

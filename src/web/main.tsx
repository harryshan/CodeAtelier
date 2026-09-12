/**
 * 文件作用：将 React 主应用挂载到 HTML 页面入口。
 *
 * 模块协作与输入输出：
 * 由 index.html 的 module 脚本加载，是 Vite 构建的前端入口。
 *
 * 代码结构与执行顺序：
 * 1. 导入 React、createRoot 和顶层 App 组件。
 * 2. 查找页面约定的 root 元素，创建 React 根并在 StrictMode 下渲染 App。
 *
 * 关键约束：
 * HTML 必须提供匹配容器；会话状态和后端连接由 App 及其 Hook 管理。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

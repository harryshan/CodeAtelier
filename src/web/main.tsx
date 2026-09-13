/**
 * 浏览器加载的 React 入口，由 index.html 引用，Vite 从这里构建前端。
 *
 * 1. 引入 React、createRoot 和主页面 App。
 * 2. 找到 HTML 中的 root 容器，在 StrictMode 下渲染 App。
 *
 * root 的 ID 要与 index.html 一致；会话加载和后端连接由 App 负责。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

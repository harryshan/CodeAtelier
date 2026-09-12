/**
 * 文件作用：将 React 主应用挂载到 HTML 页面入口。
 * 代码结构：导入 React、DOM 渲染器和 App 后，在 root 容器中以 StrictMode 渲染应用。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * 浏览器加载的 React 入口，由 index.html 引用，Vite 从这里构建前端。
 *
 * 1. 根据固定 query view=replay 选择阅读器，否则选择主页面；两者分别惰性加载，避免全局样式相互污染。
 * 2. 找到 HTML 中的 root 容器，在 StrictMode、共用 AccessGate 与 Suspense 下挂载选定页面。
 *
 * 根路径 query 同时兼容 Fastify 静态入口与 Vite，不需要服务端路径回退或新增文件读取 API。
 * root 的 ID 要与 index.html 一致；仅 App 管理会话，阅读器只处理浏览器显式选择的本地 JSON。
 */

import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AccessGate } from "./AccessGate";

const App = lazy(() => import("./App"));
const ReplayViewer = lazy(() => import("../replay-viewer/ReplayViewer"));
const showReplay =
  new URLSearchParams(window.location.search).get("view") === "replay";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccessGate>
      <Suspense fallback={<p role="status">正在加载页面…</p>}>
        {showReplay ? <ReplayViewer /> : <App />}
      </Suspense>
    </AccessGate>
  </React.StrictMode>,
);

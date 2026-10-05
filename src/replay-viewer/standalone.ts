/**
 * 可选单文件导出的浏览器启动入口，html.ts 用 esbuild 打包本文件，Web 页面不导入它。
 * 1. 从生成模板取固定容器与内嵌 JSON 的文本，不读取远程 URL 或载荷内的路径。
 * 2. 将两者交给共享 mountViewer，解析错误与本地文件选择由该阅读器处理。
 * 不连接后端；普通使用应通过主界面的对话阅读器，不需要执行这个兼容入口。
 */

import { mountViewer } from "./browser.js";

mountViewer(
  document.getElementById("app")!,
  document.getElementById("replay-data")?.textContent ?? null,
);

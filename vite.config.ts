/**
 * 文件作用：配置 React Web UI 的开发服务和生产构建。
 * 代码结构：启用 React 插件，指定前端构建目录，并将开发期 API 请求代理到本机后端。
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web" },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4142" } },
});

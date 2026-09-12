/**
 * 文件作用：配置 React Web UI 的开发服务和生产构建。
 *
 * 使用场景与输入输出：
 * 由 dev:web 和 build 使用，连接 React 转换、静态资源输出及开发期后端代理。
 *
 * 代码结构与阅读顺序：
 * 1. plugins 启用 React，build 将前端产物写入 dist/web。
 * 2. server 固定开发端口，并把 /api 代理给本机生产后端端口。
 *
 * 维护注意事项：
 * 代理只用于开发，生产静态文件由 Fastify 提供；启动命令另行约束监听回环地址。
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web" },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4142" } },
});

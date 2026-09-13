/**
 * 配置 React 开发服务和前端构建，由 pnpm dev:web 和 pnpm build 使用。
 *
 * 1. plugins 启用 React 转换，build 将网页产物写入 dist/web。
 * 2. server 指定开发端口，把 /api 请求代理到本机后端。
 *
 * 代理只在开发时使用；生产网页由 Fastify 提供。开发启动命令负责指定回环监听地址。
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web" },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4142" } },
});

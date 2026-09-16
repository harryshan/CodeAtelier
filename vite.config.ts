/**
 * 配置 React 开发服务和前端构建，由 pnpm dev:web 和 pnpm build 使用。
 *
 * 1. plugins 启用 React 转换，build 将网页产物写入 dist/web。
 * 2. server 指定开发端口，把 /api 请求代理到与后端相同的受限回环地址和端口。
 *
 * 代理只在开发时使用；生产网页由 Fastify 提供。开发启动命令负责指定回环监听地址。
 */

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { listeningUrl, loopbackAddress } from "./src/server/listen-address.js";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "CODEATELIER_");
  const address = loopbackAddress(environment);
  const port = Number(environment.CODEATELIER_PORT || 4142);

  return {
    plugins: [react()],
    build: { outDir: "dist/web" },
    server: { port: 5173, proxy: { "/api": listeningUrl(address, port) } },
  };
});

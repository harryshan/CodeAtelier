/**
 * 配置 React 开发服务和前端构建，由 pnpm dev:web 和 pnpm build 使用。
 *
 * 1. plugins 启用 React 转换，build 将网页产物写入 dist/web；所有模式禁止读取 dotenv。
 * 2. server 使用与后端相同的监听范围，并把 /api 请求代理到可连接的本机地址和端口。
 *
 * 代理只在开发时使用；生产网页由 Fastify 提供。开发启动命令负责指定回环监听地址。
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  listeningAddress,
  listeningUrl,
  proxyAddress,
} from "./src/server/listen-address.js";

export default defineConfig(({ mode }) => {
  const isTestMode = mode === "test";
  const environment = isTestMode ? process.env : {};
  const address = listeningAddress(environment);
  const port = Number(environment.CODEATELIER_PORT || 4142);

  return {
    envFile: false,
    plugins: [react()],
    build: { outDir: "dist/web" },
    server: {
      host: address,
      port: 5173,
      proxy: { "/api": listeningUrl(proxyAddress(address), port) },
    },
  };
});

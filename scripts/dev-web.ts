/**
 * pnpm dev:web 的开发入口，支持与后端一致的 --data-dir，不加载 dotenv。
 * 1. 读取并验证启动配置，只用监听地址/端口建立 Vite API 代理。
 * 2. 创建 React 开发服务器并监听 5173；不启动第二个后端、不改写设置。
 * 3. SIGINT/SIGTERM 关闭 Vite，凭据不进入 Vite define 或浏览器代码。
 */
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { startupConfig } from "../src/config/startup.js";
import { listeningUrl, proxyAddress } from "../src/server/listen-address.js";

const config = startupConfig();
const server = await createServer({
  configFile: false,
  envFile: false,
  plugins: [react()],
  server: {
    host: config.server!.listenAddress,
    port: 5173,
    proxy: {
      "/api": listeningUrl(
        proxyAddress(config.server!.listenAddress),
        config.server!.port,
      ),
    },
  },
});
await server.listen();
server.printUrls();
process.on("SIGINT", () => void server.close());
process.on("SIGTERM", () => void server.close());

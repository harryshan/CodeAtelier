/**
 * 后端进程入口，由 pnpm dev 或 pnpm start 启动。
 * 这里准备配置、日志和 HTTP 应用，并在收到退出信号时关闭服务。
 *
 * 1. 尝试加载可选的 .env，再创建 Config 和能读取最新密钥的日志实例。
 * 2. 调用 createApp，按 CODEATELIER_PORT 在 127.0.0.1 上监听，并记录访问地址。
 * 3. SIGINT 和 SIGTERM 都调用 stop，由 shutdown 保存中断状态并释放资源；关闭失败时设置非零退出码。
 *
 * 服务只监听回环地址，具体的任务和连接清理由 app.ts 统一处理。
 */

import { Config } from "../config/config.js";
import { createLogger } from "../logging/logger.js";
import { createApp } from "./app.js";

try {
  process.loadEnvFile();
} catch {
  /* .env 可选，也可以只用环境变量配置。 */
}

const config = new Config();

const log = createLogger(config.directory, config.settings.logLevel, () => [
  config.apiKey,
]);

const { app, shutdown } = await createApp(config, log, undefined, () =>
  process.exit(0),
);

const port = Number(process.env.CODEATELIER_PORT || 4142);

await app.listen({ host: "127.0.0.1", port });

log.info({
  event: "server.ready",
  module: "server",
  url: `http://127.0.0.1:${port}`,
});

const stop = () => {
  void shutdown().catch((error) => {
    log.error({
      event: "server.shutdown_failed",
      module: "server",
      errorName: error?.name,
    });
    process.exitCode = 1;
  });
};

process.on("SIGINT", stop);

process.on("SIGTERM", stop);

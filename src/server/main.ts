/**
 * 文件作用：启动 CodeAtelier 本机后端并协调进程退出。
 * 代码结构：先加载可选环境文件并初始化配置、日志和应用，再读取端口并监听回环地址，最后将终端信号接入统一关闭流程。
 */

import { Config } from "../config/config.js";
import { createLogger } from "../logging/logger.js";
import { createApp } from "./app.js";

try {
  process.loadEnvFile();
} catch {
  /* .env is optional. */
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

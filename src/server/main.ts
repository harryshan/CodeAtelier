/**
 * 文件作用：启动 CodeAtelier 本机后端并协调进程退出。
 *
 * 模块协作与输入输出：
 * 生产后端进程入口，由 dev/start 脚本启动；负责配置与资源组装，不实现具体 API。
 *
 * 代码结构与执行顺序：
 * 1. 尝试加载可选 .env，再创建 Config 和能动态读取密钥的日志实例。
 * 2. 调用 createApp，读取 CODEATELIER_PORT 并监听 127.0.0.1，记录可访问地址。
 * 3. SIGINT/SIGTERM 共用 stop，交由 shutdown 释放资源，失败时设置非零退出状态。
 *
 * 关键约束：
 * 只监听回环地址；关闭的状态持久化与连接清理由应用层统一处理。
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

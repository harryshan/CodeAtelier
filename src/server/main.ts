/**
 * 后端进程入口，由 pnpm dev 或 pnpm start 启动。
 * 这里准备配置、日志和 HTTP 应用，并在收到退出信号时关闭服务。
 *
 * 1. 尝试加载可选的 .env，再创建 Config 和能读取最新密钥的日志实例。
 * 2. 调用 createApp，按 CODEATELIER_PORT 和受限的 CODEATELIER_LISTEN_ADDRESS 在回环地址上监听，并记录访问地址。
 * 3. 由 launcher.ts fork 时，requestReload 在旧进程关闭后通过固定 IPC 事件请求父进程启动新的构建产物。
 * 4. SIGINT 和 SIGTERM 都调用 stop，由 shutdown 保存中断状态并释放资源；关闭失败时设置非零退出码。
 *
 * 服务只监听回环地址，具体的任务和连接清理由 app.ts 统一处理。没有受监督父进程时不注册重载回调，避免自行重启出游离进程。
 */

import { Config } from "../config/config.js";
import { createLogger } from "../logging/logger.js";
import { createApp } from "./app.js";
import { listeningUrl, loopbackAddress } from "./listen-address.js";

try {
  process.loadEnvFile();
} catch {
  /* .env 可选，也可以只用环境变量配置。 */
}

const config = new Config();

const log = createLogger(config.directory, config.settings.logLevel, () => [
  config.apiKey,
]);

const requestReload = () => {
  if (!process.send || !process.connected) {
    log.error({
      event: "server.reload_unavailable",
      module: "server",
    });
    process.exit(1);
  }

  try {
    process.send({ event: "server.reload" }, (error) => {
      if (error) {
        log.error({
          event: "server.reload_failed",
          module: "server",
          err: error,
        });
        process.exit(1);
      }

      process.exit(0);
    });
  } catch (error) {
    log.error({
      event: "server.reload_failed",
      module: "server",
      err: error,
    });
    process.exit(1);
  }
};

const { app, shutdown } = await createApp(
  config,
  log,
  undefined,
  () => process.exit(0),
  process.send && process.connected ? requestReload : undefined,
);

const port = Number(process.env.CODEATELIER_PORT || 4142);
const address = loopbackAddress();
const url = listeningUrl(address, port);

await app.listen({ host: address, port });

log.info({
  event: "server.ready",
  module: "server",
  url,
});

const stop = () => {
  void shutdown().catch((error) => {
    log.error({
      event: "server.shutdown_failed",
      module: "server",
      err: error,
    });
    process.exitCode = 1;
  });
};

process.on("SIGINT", stop);

process.on("SIGTERM", stop);

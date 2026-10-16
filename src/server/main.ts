/**
 * 后端进程入口，由 pnpm dev 或 pnpm start 启动。
 * 这里准备配置、日志和 HTTP 应用，并在收到退出信号时关闭服务。
 *
 * 1. 解析 --data-dir 并读取私有 settings.json，不加载 dotenv；旧文件需显式迁移。
 * 2. 使用启动快照中的监听地址、端口和门禁，创建能脱敏历次密钥的日志入口。
 * 3. 由 launcher.ts fork 时，requestReload 在旧进程关闭后通过固定 IPC 事件请求父进程启动新的构建产物。
 * 4. SIGINT 和 SIGTERM 都调用 stop，由 shutdown 保存中断状态并释放资源；关闭失败时设置非零退出码。
 *
 * 服务只监听回环地址，具体的任务和连接清理由 app.ts 统一处理。没有受监督父进程时不注册重载回调，避免自行重启出游离进程。
 */

import { startupConfig } from "../config/startup.js";
import { createLogger } from "../logging/logger.js";
import { createApp } from "./app.js";
import { allowsNetworkAccess, listeningUrl } from "./listen-address.js";

const config = startupConfig();

const log = createLogger(config.directory, config.settings.logLevel, () =>
  config.errorSecrets(),
);

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

const port = config.server!.port;
const address = config.server!.listenAddress;
const networkAccess = allowsNetworkAccess(address);
const url = listeningUrl(address, port);
const { app, shutdown } = await createApp(
  config,
  log,
  undefined,
  () => process.exit(0),
  process.send && process.connected ? requestReload : undefined,
  networkAccess,
);

await app.listen({ host: address, port });

if (networkAccess) {
  log.warn({
    event: "server.network_access_enabled",
    module: "server",
    address,
    port,
  });
}

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

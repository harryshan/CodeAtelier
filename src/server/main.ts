import { Config } from "../config/settings.js";
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

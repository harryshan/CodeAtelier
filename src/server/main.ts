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
const { app, engine } = await createApp(config, log);
const port = Number(process.env.CODEATELIER_PORT || 4142);
await app.listen({ host: "127.0.0.1", port });
log.info({
  event: "server.ready",
  module: "server",
  url: `http://127.0.0.1:${port}`,
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await engine.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

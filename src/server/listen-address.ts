/**
 * 解析后端与开发代理共同使用的监听地址，确保环境变量不会把本机服务暴露到局域网或公网。
 * server/main.ts 用它传入 Fastify 的 listen，vite.config.ts 用同一结果构造开发 API 代理地址。
 *
 * 1. loopbackAddress 从环境变量读取地址，空值时使用 IPv4 回环默认值，并拒绝非明确回环地址。
 * 2. listeningUrl 将 IPv6 地址加方括号后组合为浏览器和代理可用的 HTTP URL。
 *
 * 本模块是纯配置校验：不读取文件、不启动端口；调用方负责在配置错误时终止各自的启动流程。
 */

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

/** 取得允许 Fastify 绑定的明确回环地址。 */
export function loopbackAddress(
  environment: Record<string, string | undefined> = process.env,
): string {
  const address = environment.CODEATELIER_LISTEN_ADDRESS?.trim() || "127.0.0.1";

  if (!LOOPBACK_ADDRESSES.has(address)) {
    throw new Error(
      "CODEATELIER_LISTEN_ADDRESS 必须是 127.0.0.1 或 ::1，以确保服务只允许本机访问。",
    );
  }

  return address;
}

/** 为已校验的回环地址和端口构造 URL，并保留 IPv6 URL 所需的方括号。 */
export function listeningUrl(address: string, port: number): string {
  const hostname = address.includes(":") ? `[${address}]` : address;

  return `http://${hostname}:${port}`;
}

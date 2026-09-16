/**
 * 解析后端与开发代理共同使用的监听地址，默认保持本机回环；用户显式选择通配地址时才开放局域网访问。
 * server/main.ts 用它传入 Fastify 的 listen 并决定 HTTP 来源策略，vite.config.ts 用它配置开发服务器和 API 代理。
 *
 * 1. listeningAddress 从环境变量读取受支持的 IPv4/IPv6 回环或通配绑定地址，空值时使用 IPv4 回环默认值。
 * 2. allowsNetworkAccess 标明通配绑定是否会接收局域网连接；proxyAddress 为 Vite 代理保留可连接的本机回环目标。
 * 3. listeningUrl 将 IPv6 地址加方括号后组合为日志和代理可用的 HTTP URL。
 *
 * 本模块是纯配置校验：不读取文件、不启动端口；调用方负责在配置错误时终止各自的启动流程。
 */

const LISTEN_ADDRESSES = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

/** 取得允许 Fastify 或 Vite 绑定的地址；通配地址仅在用户显式配置时启用。 */
export function listeningAddress(
  environment: Record<string, string | undefined> = process.env,
): string {
  const address = environment.CODEATELIER_LISTEN_ADDRESS?.trim() || "127.0.0.1";

  if (!LISTEN_ADDRESSES.has(address)) {
    throw new Error(
      "CODEATELIER_LISTEN_ADDRESS 必须是 127.0.0.1、::1、0.0.0.0 或 ::。",
    );
  }

  return address;
}

/** 判断地址是否会接收本机以外的网络接口连接。 */
export function allowsNetworkAccess(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

/** 为通配监听返回 Vite 可主动连接的对应回环地址。 */
export function proxyAddress(address: string): string {
  if (address === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (address === "::") {
    return "::1";
  }

  return address;
}

/** 为已校验的监听或代理地址和端口构造 URL，并保留 IPv6 URL 所需的方括号。 */
export function listeningUrl(address: string, port: number): string {
  const hostname = address.includes(":") ? `[${address}]` : address;

  return `http://${hostname}:${port}`;
}

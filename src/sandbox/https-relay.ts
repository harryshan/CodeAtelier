/**
 * 为 Windows Sandbox Push Runner 提供固定回环端口上的认证 HTTPS CONNECT relay。
 * Native supervisor 只把一次性凭据交给同一 Job 中的固定 askpass helper；Git 再以 Basic proxy auth
 * 连接本 relay。普通 Agent Runtime 即使能到达 WFP 放行端口，也没有有效 lease。
 *
 * 1. start 只监听 127.0.0.1 的安装端口，普通 HTTP 请求一律拒绝。
 * 2. issueLease 绑定规范 host、期限、连接数和总字节；revoke 在 Push Runner 结束时立即失效。
 * 3. CONNECT 同时核对 Basic token、精确 host 和 443 端口，再解析全部 DNS 地址并拒绝非公网类别。
 * 4. relay 连接到已核验的具体 IP，TLS 仍由 Git 对原 host 完成；重定向到其它 host 会产生新的 CONNECT 并被拒绝。
 * 5. 日志只记录 lease ID/host 摘要、计数和结果，不记录 token、URL path、凭据或传输内容。
 *
 * 这不是内容防泄漏边界：获准 host 可接收仓库内容，Push Runner 内的 Git 配置和子进程也可使用该 lease。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";

interface RelayLease {
  leaseId: string;
  token: string;
  host: string;
  expiresAt: number;
  remainingBytes: number;
  connections: number;
  revoked: boolean;
  sockets: Set<{ client: Duplex; upstream: net.Socket }>;
}

export interface IssuedRelayLease {
  leaseId: string;
  token: string;
  proxyUrl: string;
}

const MAXIMUM_CONNECTIONS = 16;
const MAXIMUM_BYTES = 512 * 1024 * 1024;
const MAXIMUM_LEASE_MS = 5 * 60 * 1000;

function hostDigest(host: string) {
  return createHash("sha256").update(host).digest("hex").slice(0, 12);
}

function publicIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) {
    return false;
  }

  const [a = 0, b = 0] = octets;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function publicIp(address: string) {
  if (net.isIPv4(address)) {
    return publicIpv4(address);
  }

  if (!net.isIPv6(address)) {
    return false;
  }

  const normalized = address.toLocaleLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return publicIpv4(normalized.slice("::ffff:".length));
  }

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function proxyToken(header: string | undefined) {
  if (!header?.startsWith("Basic ")) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");

    return separator >= 0 ? decoded.slice(separator + 1) : undefined;
  } catch {
    return undefined;
  }
}

export class SandboxHttpsRelay {
  private server?: http.Server;
  private leases = new Map<string, RelayLease>();
  private actualPort?: number;

  constructor(
    private port: number,
    private log?: Logger,
    private now: () => number = Date.now,
  ) {}

  async start() {
    if (this.server) {
      return;
    }

    const server = http.createServer((_request, response) => {
      response.writeHead(405, { Connection: "close" });
      response.end();
    });
    server.on("connect", (request, client, head) => {
      void this.connect(request, client, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Sandbox HTTPS relay 未取得 TCP 监听地址。");
    }

    this.server = server;
    this.actualPort = address.port;
    this.log?.info({
      event: "broker.relay_attest.completed",
      module: "sandbox",
      addressFamily: "ipv4",
    });
  }

  issueLease(host: string, timeoutMs: number): IssuedRelayLease {
    if (!this.server || !this.actualPort || !/^[a-z0-9.-]+$/.test(host)) {
      throw new Error("Sandbox HTTPS relay 尚未就绪或 host 无效。");
    }

    const token = randomBytes(32).toString("base64url");
    const lease: RelayLease = {
      leaseId: randomUUID(),
      token,
      host,
      expiresAt: this.now() + Math.min(timeoutMs, MAXIMUM_LEASE_MS),
      remainingBytes: MAXIMUM_BYTES,
      connections: 0,
      revoked: false,
      sockets: new Set(),
    };
    this.leases.set(token, lease);
    this.log?.info({
      event: "sandbox.proxy_lease.issued",
      module: "sandbox",
      leaseId: lease.leaseId,
      hostDigest: hostDigest(host),
    });

    return {
      leaseId: lease.leaseId,
      token,
      proxyUrl: `http://127.0.0.1:${this.actualPort}`,
    };
  }

  revoke(lease: IssuedRelayLease) {
    const current = this.leases.get(lease.token);
    if (current) {
      current.revoked = true;
      for (const pair of current.sockets) {
        pair.client.destroy();
        pair.upstream.destroy();
      }

      current.sockets.clear();
      this.leases.delete(lease.token);
      this.log?.info({
        event: "sandbox.proxy_lease.revoked",
        module: "sandbox",
        leaseId: current.leaseId,
        connections: current.connections,
      });
    }
  }

  async close() {
    for (const lease of [...this.leases.values()]) {
      this.revoke({
        leaseId: lease.leaseId,
        token: lease.token,
        proxyUrl: "",
      });
    }

    const server = this.server;
    this.server = undefined;
    this.actualPort = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private reject(client: Duplex, status = "403 Forbidden") {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  }

  private async connect(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ) {
    const token = proxyToken(request.headers["proxy-authorization"]);
    const lease = token ? this.leases.get(token) : undefined;
    if (
      !lease ||
      lease.revoked ||
      lease.expiresAt < this.now() ||
      lease.connections >= MAXIMUM_CONNECTIONS
    ) {
      this.reject(client, "407 Proxy Authentication Required");

      return;
    }

    const authority = /^([A-Za-z0-9.-]+):443$/.exec(request.url ?? "");
    if (!authority) {
      this.reject(client);

      return;
    }

    let target: URL;
    try {
      target = new URL(`https://${authority[1]}`);
    } catch {
      this.reject(client);

      return;
    }

    if (
      target.hostname.toLocaleLowerCase() !== lease.host ||
      target.pathname !== "/" ||
      target.username ||
      target.password
    ) {
      this.reject(client);

      return;
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(lease.host, { all: true, verbatim: true });
    } catch {
      this.reject(client, "502 Bad Gateway");

      return;
    }

    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !publicIp(address))
    ) {
      this.reject(client);

      return;
    }

    lease.connections += 1;
    const chosen = addresses[0]!;
    const upstream = net.connect({
      host: chosen.address,
      port: 443,
      family: chosen.family,
    });
    const pair = { client, upstream };
    lease.sockets.add(pair);
    const lifetime = setTimeout(
      () => {
        client.destroy();
        upstream.destroy();
      },
      Math.max(1, lease.expiresAt - this.now()),
    );
    const forget = () => {
      clearTimeout(lifetime);
      lease.sockets.delete(pair);
    };

    const account = (chunk: Buffer) => {
      lease.remainingBytes -= chunk.length;
      if (
        lease.remainingBytes < 0 ||
        lease.revoked ||
        lease.expiresAt < this.now()
      ) {
        client.destroy();
        upstream.destroy();
      }
    };

    client.on("data", account);
    upstream.on("data", account);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }

      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => this.reject(client, "502 Bad Gateway"));
    upstream.once("close", forget);
    client.once("close", forget);
    client.once("error", () => upstream.destroy());
    this.log?.info({
      event: "broker.proxy_connect.accepted",
      module: "sandbox",
      leaseId: lease.leaseId,
      hostDigest: hostDigest(lease.host),
    });
  }
}

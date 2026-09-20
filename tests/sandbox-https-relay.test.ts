/**
 * 验证 Sandbox HTTPS relay 的最小安全机制，不访问互联网或真实 Git remote。
 * 测试在随机回环端口创建本地 proxy，并只发送 CONNECT 头。
 *
 * 1. 缺失/错误 token 在解析目标前返回 407。
 * 2. 有效 lease 仍拒绝错误 host 和解析为回环地址的获准 host。
 * 3. revoke 后同一 token 立即失效，防止 Push Runner 结束后重放。
 *
 * 真实公网 DNS、TLS 和 Git push 留给提升后的产品集成测试；本文件不会建立外部连接。
 */

import net from "node:net";
import { expect, it } from "vitest";
import { SandboxHttpsRelay } from "../src/sandbox/https-relay.js";

async function connect(port: number, authority: string, token?: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const authorization = token
        ? `Proxy-Authorization: Basic ${Buffer.from(`codeatelier:${token}`).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

it("binds CONNECT to an authenticated lease, exact host and public DNS", async () => {
  const relay = new SandboxHttpsRelay(0);
  await relay.start();
  const lease = relay.issueLease("localhost", 10_000);
  const port = Number(new URL(lease.proxyUrl).port);

  await expect(connect(port, "localhost:443")).resolves.toContain("407");
  await expect(
    connect(port, "example.test:443", lease.token),
  ).resolves.toContain("403");
  await expect(connect(port, "localhost:443", lease.token)).resolves.toContain(
    "403",
  );

  relay.revoke(lease);
  await expect(connect(port, "localhost:443", lease.token)).resolves.toContain(
    "407",
  );
  await relay.close();
});

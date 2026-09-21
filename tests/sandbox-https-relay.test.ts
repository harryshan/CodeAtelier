/**
 * 验证 Windows Sandbox HTTPS relay 的最小安全机制，不访问互联网或真实 Git remote；非 Windows 整组跳过。
 * 测试在随机回环端口创建本地 proxy，并只发送 CONNECT 头。
 *
 * 1. 缺失/错误 token 在解析目标前返回 407。
 * 2. 有效 lease 仍拒绝错误 host 和解析为回环地址的获准 host。
 * 3. IPv4/IPv6 地址分类拒绝私网、metadata 可达转换和隧道前缀，只接受普通公网单播。
 * 4. revoke 后同一 token 立即失效，防止 Push Runner 结束后重放。
 *
 * 真实公网 DNS、TLS 和 Git push 留给提升后的产品集成测试；本文件不会建立外部连接。
 */

import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  isPublicRelayAddress,
  SandboxHttpsRelay,
} from "../src/sandbox/https-relay.js";

it.each([
  ["8.8.8.8", true],
  ["127.0.0.1", false],
  ["169.254.169.254", false],
  ["2606:4700:4700::1111", true],
  ["::1", false],
  ["fc00::1", false],
  ["fe80::1", false],
  ["::ffff:169.254.169.254", false],
  ["2001:db8::1", false],
  ["2001::1", false],
  ["2002:a9fe:a9fe::1", false],
  ["64:ff9b::a9fe:a9fe", false],
] as const)("classifies relay address %s", (address, expected) => {
  expect(isPublicRelayAddress(address)).toBe(expected);
});

describe.skipIf(process.platform !== "win32")(
  "Windows sandbox HTTPS relay",
  () => {
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
      await expect(
        connect(port, "localhost:443", lease.token),
      ).resolves.toContain("403");

      relay.revoke(lease);
      await expect(
        connect(port, "localhost:443", lease.token),
      ).resolves.toContain("407");
      await relay.close();
    });
  },
);

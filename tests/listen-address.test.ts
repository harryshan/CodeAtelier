/**
 * 验证监听地址环境变量的纯配置边界，不启动 HTTP 服务或连接模型。
 * 测试直接调用 server/listen-address.ts，覆盖默认回环、显式局域网通配监听、Vite 代理回退和拒绝未知地址。
 *
 * 1. 默认或空环境变量必须返回固定的 127.0.0.1。
 * 2. 显式 IPv6 回环与 IPv4/IPv6 通配地址必须生成有效 URL，并明确其网络访问范围。
 * 3. 通配监听下 Vite 仍须代理到本机回环；任意不支持的地址必须在监听前被拒绝。
 */

import { expect, it } from "vitest";
import {
  allowsNetworkAccess,
  listeningAddress,
  listeningUrl,
  proxyAddress,
} from "../src/server/listen-address.js";

it("uses the IPv4 loopback address when the listening environment variable is absent or empty", () => {
  expect(listeningAddress({})).toBe("127.0.0.1");
  expect(listeningAddress({ CODEATELIER_LISTEN_ADDRESS: "   " })).toBe(
    "127.0.0.1",
  );
});

it("accepts IPv6 loopback and explicit LAN wildcard bindings", () => {
  const ipv6Loopback = listeningAddress({
    CODEATELIER_LISTEN_ADDRESS: "::1",
  });

  expect(ipv6Loopback).toBe("::1");
  expect(listeningUrl(ipv6Loopback, 4142)).toBe("http://[::1]:4142");
  expect(allowsNetworkAccess(ipv6Loopback)).toBe(false);

  for (const address of ["0.0.0.0", "::"]) {
    expect(listeningAddress({ CODEATELIER_LISTEN_ADDRESS: address })).toBe(
      address,
    );
    expect(allowsNetworkAccess(address)).toBe(true);
  }
});

it("keeps the development proxy on a local reachable address for wildcard bindings", () => {
  expect(proxyAddress("0.0.0.0")).toBe("127.0.0.1");
  expect(proxyAddress("::")).toBe("::1");
  expect(proxyAddress("127.0.0.1")).toBe("127.0.0.1");
});

it("rejects unsupported listening addresses", () => {
  for (const address of ["192.168.1.10", "example.com"]) {
    expect(() =>
      listeningAddress({ CODEATELIER_LISTEN_ADDRESS: address }),
    ).toThrow("CODEATELIER_LISTEN_ADDRESS");
  }
});

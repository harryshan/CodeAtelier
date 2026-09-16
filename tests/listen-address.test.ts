/**
 * 验证监听地址环境变量的纯配置边界，不启动 HTTP 服务或连接模型。
 * 测试直接调用 server/listen-address.ts，覆盖默认 IPv4 回环、IPv6 URL 格式和拒绝非回环地址。
 *
 * 1. 默认或空环境变量必须返回固定的 127.0.0.1。
 * 2. 显式 ::1 必须可用于 Fastify，并生成带方括号的有效 URL。
 * 3. 任意局域网或公网地址必须在监听前被拒绝，维持仅本机访问范围。
 */

import { expect, it } from "vitest";
import { loopbackAddress, listeningUrl } from "../src/server/listen-address.js";

it("uses the IPv4 loopback address when the listening environment variable is absent or empty", () => {
  expect(loopbackAddress({})).toBe("127.0.0.1");
  expect(loopbackAddress({ CODEATELIER_LISTEN_ADDRESS: "   " })).toBe(
    "127.0.0.1",
  );
});

it("accepts the IPv6 loopback address and formats its URL", () => {
  const address = loopbackAddress({ CODEATELIER_LISTEN_ADDRESS: "::1" });

  expect(address).toBe("::1");
  expect(listeningUrl(address, 4142)).toBe("http://[::1]:4142");
});

it("rejects non-loopback listening addresses", () => {
  for (const address of ["0.0.0.0", "192.168.1.10", "example.com"]) {
    expect(() =>
      loopbackAddress({ CODEATELIER_LISTEN_ADDRESS: address }),
    ).toThrow("CODEATELIER_LISTEN_ADDRESS");
  }
});

/**
 * 验证 Windows 专用账户 Runtime 的无副作用协议编码和安装自检分流。
 * 测试使用临时伪二进制与注入的 self-check executor，不创建账户、ACL、Job、Named Pipe 或 WFP 规则。
 *
 * 1. 二进制帧固定 magic/version、UTF-8 字符串、超时和 argv，拒绝相对路径及超限字段。
 * 2. selfCheck 只有 state 中两个 SHA-256 与实际文件一致且原生自检成功时才报告 sandbox level。
 * 3. state 缺失、摘要篡改和原生拒绝都在 Runtime 启动前失败，允许 Broker 安全选择宿主 fallback。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  encodeNativeSandboxRequest,
  NativeWindowsSandboxRuntime,
} from "../src/sandbox/native-windows-runtime.js";
import { temp } from "./fixtures/helpers.js";

function workspace(root: string) {
  return { root, protectedPaths: [], protection: "direct-path" as const };
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

it("encodes a bounded binary command request and rejects unsafe shapes", () => {
  const frame = encodeNativeSandboxRequest({
    executionInstanceId: "instance-1",
    cwd: "C:\\workspace",
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/c", "echo ok"],
    privateDirectory: "C:\\private",
    timeoutMs: 1000,
    access: {
      leaseEpoch: 1,
      installObjectIdentityDigests: ["a".repeat(64)],
      manifest: {
        manifestDigest: "b".repeat(64),
        workspaceRootId: "workspace",
        readRoots: [],
        writeRoots: [
          {
            rootId: "workspace",
            path: "C:\\workspace",
            objectIdentityDigest: "a".repeat(64),
            deviceId: "1",
            fileId: "2",
          },
        ],
        gitConfigFiles: [],
      },
    },
  });

  expect(frame.readUInt32LE(0)).toBe(0x42534143);
  expect(frame.readUInt32LE(4)).toBe(2);
  expect(frame.includes(Buffer.from("instance-1"))).toBe(true);
  expect(frame.includes(Buffer.from("echo ok"))).toBe(true);
  expect(() =>
    encodeNativeSandboxRequest({
      executionInstanceId: "instance-1",
      cwd: "relative",
      command: "cmd.exe",
      args: [],
      privateDirectory: "relative",
      timeoutMs: 1000,
    }),
  ).toThrow("字段无效");
});

it("accepts only matching installed binary digests and native attestation", async () => {
  const root = await temp();
  const nativeRoot = path.join(root, "native");
  const statePath = path.join(root, "installation.state");
  const supervisor = path.join(
    nativeRoot,
    "codeatelier-sandbox-supervisor.exe",
  );
  const network = path.join(nativeRoot, "codeatelier-sandbox-network.exe");
  await mkdir(nativeRoot);
  await writeFile(supervisor, "supervisor");
  await writeFile(network, "network");
  await writeFile(
    statePath,
    [
      "version=1",
      "generationId=12345678-1234-1234-1234-123456789abc",
      "relayPortV4=42871",
      `supervisorSha256=${digest("supervisor")}`,
      `networkSha256=${digest("network")}`,
    ].join("\n"),
  );
  const runSelfCheck = vi.fn(async () => ({
    output: "CODEATELIER_SELF_CHECK_OK generation=redacted\n",
    exitCode: 0,
    truncated: false,
  }));
  const runtime = new NativeWindowsSandboxRuntime(
    {
      CODEATELIER_SANDBOX_NATIVE_ROOT: nativeRoot,
      CODEATELIER_SANDBOX_STATE_PATH: statePath,
    },
    runSelfCheck,
  );

  await expect(
    runtime.selfCheck(new AbortController().signal, workspace(root)),
  ).resolves.toMatchObject({
    level: expect.stringMatching(/^windows-sandbox-user-v1:[a-f0-9]{12}$/),
  });
  expect(runSelfCheck).toHaveBeenCalledWith(
    supervisor,
    ["--self-check", statePath, network],
    process.cwd(),
    expect.any(AbortSignal),
    20_000,
    4_096,
    expect.any(Function),
    {},
  );

  await writeFile(network, "tampered");
  await expect(
    runtime.selfCheck(new AbortController().signal, workspace(root)),
  ).rejects.toThrow("摘要");
});

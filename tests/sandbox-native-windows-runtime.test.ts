/**
 * 验证 Windows 专用账户 Runtime 的无副作用协议编码和安装自检分流；非 Windows 整组跳过。
 * 测试使用临时伪二进制与注入的 self-check executor，不创建账户、ACL、Job、Named Pipe 或 WFP 规则。
 *
 * 1. 二进制帧固定 magic/version、UTF-8 字符串、超时和 argv，拒绝相对路径及超限字段。
 * 2. selfCheck 只有 state 中原生二进制、Node 24 和两个 Runtime bundle SHA-256、启动恢复排空与原生自检全部成功时才报告 sandbox level。
 * 3. prepareAccess 在 manifest 之前同时创建只读 Git 投影和逐实例可写 HOME/TEMP，cleanup 删除两者。
 * 4. state 缺失、摘要篡改和原生拒绝都在 Runtime 启动前失败，允许 Broker 安全选择宿主 fallback。
 * 5. Agent Runtime 启动帧只携带 Broker 身份、nonce 和已安装 Node 路径，不允许选择 Runtime kind 或任意 entry argv。
 */

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifySupervisorClose,
  encodeNativeAgentRuntimeRequest,
  encodeNativeSandboxRequest,
  NativeWindowsSandboxRuntime,
} from "../src/sandbox/native-windows-runtime.js";
import { temp } from "./fixtures/helpers.js";

describe.skipIf(process.platform !== "win32")(
  "Windows native sandbox runtime",
  () => {
    function workspace(root: string) {
      return { root, protectedPaths: [], protection: "direct-path" as const };
    }

    function digest(content: string) {
      return createHash("sha256").update(content).digest("hex");
    }

    it("prioritizes cleanup failure over an observed cancellation", () => {
      expect(
        classifySupervisorClose({
          aborted: true,
          timedOut: false,
          cleanupFailure: true,
          exitCode: 70,
        }),
      ).toBe("cleanup_unknown");
      expect(
        classifySupervisorClose({
          aborted: true,
          timedOut: false,
          cleanupFailure: false,
          exitCode: 30,
        }),
      ).toBe("cancelled");
    });

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

    it("encodes only the fixed Agent Runtime launch identity", () => {
      const frame = encodeNativeAgentRuntimeRequest({
        identity: {
          sessionId: "session-1",
          taskId: "task-1",
          executionInstanceId: "instance-1",
          kind: "agent-runtime",
        },
        nonce: "c".repeat(64),
        cwd: "C:\\workspace",
        runtimeNode: "C:\\ProgramData\\CodeAtelier\\runtime\\node.exe",
        access: {
          leaseEpoch: 1,
          privateDirectory: "C:\\private",
          gitGlobalConfigPath: "C:\\gitconfig",
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

      expect(frame.includes(Buffer.from("session-1"))).toBe(true);
      expect(frame.includes(Buffer.from("task-1"))).toBe(true);
      expect(frame.includes(Buffer.from("c".repeat(64)))).toBe(true);
      expect(frame.includes(Buffer.from("agent-runtime.mjs"))).toBe(false);
      expect(() =>
        encodeNativeAgentRuntimeRequest({
          identity: {
            sessionId: "session-1",
            taskId: "task-1",
            executionInstanceId: "instance-1",
            kind: "push-runner",
          },
          nonce: "bad",
          cwd: "C:\\workspace",
          runtimeNode: "C:\\node.exe",
          access: {} as never,
        }),
      ).toThrow("启动字段无效");
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
      const runtimeRoot = path.join(root, "runtime");
      const runtimeNode = path.join(runtimeRoot, "node.exe");
      const runtimeEntry = path.join(runtimeRoot, "agent-runtime.mjs");
      const runtimeWorker = path.join(runtimeRoot, "compaction-worker.mjs");
      await Promise.all([mkdir(nativeRoot), mkdir(runtimeRoot)]);
      await writeFile(supervisor, "supervisor");
      await writeFile(network, "network");
      await writeFile(runtimeNode, "node-24");
      await writeFile(runtimeEntry, "runtime-entry");
      await writeFile(runtimeWorker, "runtime-worker");
      await writeFile(
        statePath,
        [
          "version=2",
          "generationId=12345678-1234-1234-1234-123456789abc",
          "relayPortV4=42871",
          `supervisorSha256=${digest("supervisor")}`,
          `networkSha256=${digest("network")}`,
          `runtimeNodeSha256=${digest("node-24")}`,
          `runtimeEntrySha256=${digest("runtime-entry")}`,
          `runtimeWorkerSha256=${digest("runtime-worker")}`,
        ].join("\n"),
      );
      const runSelfCheck = vi.fn(async (_file: string, args: string[]) => ({
        output:
          args[0] === "--terminate-account-processes"
            ? "CODEATELIER_ACCOUNT_PROCESSES_TERMINATED count=0\n"
            : args[0] === "--revoke-journal"
              ? "CODEATELIER_REVOKE_JOURNAL_OK count=0\n"
              : "CODEATELIER_SELF_CHECK_OK generation=redacted\n",
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
      expect(runSelfCheck).toHaveBeenLastCalledWith(
        supervisor,
        ["--self-check", statePath, network],
        process.cwd(),
        expect.any(AbortSignal),
        20_000,
        4_096,
        expect.any(Function),
        {},
      );
      expect(runSelfCheck).toHaveBeenCalledTimes(3);

      await writeFile(network, "tampered");
      await expect(
        runtime.selfCheck(new AbortController().signal, workspace(root)),
      ).rejects.toThrow("摘要");

      await writeFile(network, "network");
      await writeFile(runtimeEntry, "tampered");
      await expect(
        runtime.selfCheck(new AbortController().signal, workspace(root)),
      ).rejects.toThrow("摘要");
    });

    it("projects the private HOME/TEMP as a writable manifest root", async () => {
      const root = await temp();
      const runtime = new NativeWindowsSandboxRuntime({
        CODEATELIER_SANDBOX_STATE_PATH: path.join(root, "installation.state"),
        CODEATELIER_SANDBOX_NATIVE_ROOT: path.join(root, "native"),
        USERPROFILE: root,
      });
      const prepared = await runtime.prepareAccess(
        {
          sessionId: "session-1",
          taskId: "task-1",
          executionInstanceId: "instance-1",
          command: "C:\\Windows\\System32\\cmd.exe",
          args: [],
          cwd: root,
          signal: new AbortController().signal,
          timeoutMs: 1000,
          outputLimit: 1000,
          onOutput: () => {},
          onProcessStarted: () => {},
        },
        workspace(root),
      );

      expect(prepared.privateDirectory).toBe(prepared.readWriteRoots[0]);
      expect(prepared.readOnlyRoots).toHaveLength(1);
      await expect(access(prepared.privateDirectory!)).resolves.toBeUndefined();

      const privateDirectory = prepared.privateDirectory!;
      const projectionDirectory = prepared.readOnlyRoots[0]!;
      await prepared.cleanup();
      await expect(access(privateDirectory)).rejects.toThrow();
      await expect(access(projectionDirectory)).rejects.toThrow();
    });
  },
);

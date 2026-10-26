/**
 * Windows grant 提示读取及启动撤销顺序回归，使用临时二进制 journal 和替代原生进程。
 * 1. 构造真实 v2 帧，验证完整身份/路径及截断、尾部、文件名、协议、链接和大小拒绝。
 * 2. 观察 terminate → mount → revoke → close 顺序；原生排空失败不得挂载，在线隔离不调用启动挂载。
 * 3. 不启动 Windows 专用账户或修改 ACL；实际挂载限制和安装态撤销由手动 verifier 覆盖。
 */
import { mkdir, writeFile, link } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readRecoveryRoots } from "../src/sandbox/recovery-roots.js";
import { NativeWindowsSandboxRuntime } from "../src/sandbox/native-windows-runtime.js";
import { temp } from "./fixtures/helpers.js";

function frame() {
  const header = Buffer.alloc(16);
  [0x42534143, 2, 1, 5].forEach((value, index) =>
    header.writeUInt32LE(value, index * 4),
  );

  return Buffer.concat([
    header,
    ...["\\\\CodeAtelier\\fixture\\", "123", "1", "a".repeat(64)].flatMap(
      (value) => {
        const bytes = Buffer.from(value);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(bytes.length);

        return [size, bytes];
      },
    ),
  ]);
}

async function fixture(bytes = frame(), name = `${"a".repeat(64)}.grant`) {
  const root = await temp();
  await mkdir(path.join(root, "grants"));
  const file = path.join(root, "grants", name);
  await writeFile(file, bytes);

  return { root, file };
}

it("reads bounded v2 roots and treats a missing directory as empty", async () => {
  const f = await fixture();
  expect(await readRecoveryRoots(f.root)).toEqual([
    "\\\\CodeAtelier\\fixture\\",
  ]);
  expect(await readRecoveryRoots(await temp())).toEqual([]);
});

it.each(["truncated", "trailing", "version", "digest", "oversize", "hardlink"])(
  "refuses %s journals",
  async (kind) => {
    let bytes = frame();
    if (kind === "truncated") {
      bytes = bytes.subarray(0, bytes.length - 1);
    } else if (kind === "trailing") {
      bytes = Buffer.concat([bytes, Buffer.from([0])]);
    } else if (kind === "version") {
      bytes.writeUInt32LE(1, 4);
    } else if (kind === "oversize") {
      bytes = Buffer.alloc(262177);
    }

    const f = await fixture(
      bytes,
      `${(kind === "digest" ? "b" : "a").repeat(64)}.grant`,
    );
    if (kind === "hardlink") {
      await link(f.file, path.join(f.root, "alias"));
    }

    await expect(readRecoveryRoots(f.root)).rejects.toThrow();
  },
);

it.each(["startup", "online", "terminate-failed", "mount-failed"])(
  "preserves native cleanup ordering for %s",
  async (mode) => {
    const f = await fixture();
    const order: string[] = [];
    const runtime = new NativeWindowsSandboxRuntime(
      {
        CODEATELIER_SANDBOX_STATE_PATH: path.join(f.root, "installation.state"),
      },
      async (_file, args) => {
        const terminating = args[0] === "--terminate-account-processes";
        order.push(terminating ? "terminate" : "revoke");

        return {
          exitCode: mode === "terminate-failed" ? 70 : 0,
          output: terminating
            ? "CODEATELIER_ACCOUNT_PROCESSES_TERMINATED"
            : "CODEATELIER_REVOKE_JOURNAL_OK",
          truncated: false,
        };
      },
      undefined,
      undefined,
      f.root,
      async (roots, _signal, revoke) => {
        expect(roots).toEqual(["\\\\CodeAtelier\\fixture\\"]);
        order.push("mount");
        if (mode === "mount-failed") {
          throw new Error("invalid virtual root");
        }

        try {
          await revoke();
        } finally {
          order.push("close");
        }
      },
    );
    const work = runtime.drainGeneration(
      new AbortController().signal,
      mode === "online"
        ? { taskId: "task", executionInstanceId: "instance" }
        : undefined,
    );
    if (mode === "mount-failed") {
      await expect(work).rejects.toMatchObject({
        code: "WINDOWS_SANDBOX_CLEANUP_UNKNOWN",
      });
      expect(order).toEqual(["terminate", "mount"]);
    } else if (mode === "terminate-failed") {
      await expect(work).rejects.toThrow();
      expect(order).toEqual(["terminate"]);
    } else {
      await work;
      expect(order).toEqual(
        mode === "online"
          ? ["terminate", "revoke"]
          : ["terminate", "mount", "revoke", "close"],
      );
    }
  },
);

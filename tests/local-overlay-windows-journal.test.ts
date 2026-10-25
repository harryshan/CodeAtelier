/**
 * Windows 原生替换的宿主发布日志回归；实际 ACL/Win32 行为由手动 verifier 验证。
 * 1. 使用真实来源和持久 journal，原生适配器替身执行备份/替换，控制确认与清理失败点。
 * 2. 验证完整提交后才清理、清理冲突不降格为 aborted，以及写后错误保留 unknown 和锁。
 * 3. 原生拒绝不回退 rename；文件原文保持，副作用未知时保留候选等待核查。
 * 4. 视图刷新只在来源 complete 后执行；刷新失败不重做来源，保留可核对的 pending 请求。
 * 不依赖已构建 helper 或系统驱动；nativeWindows 平台门禁保持真实，非 Windows 跳过这些接线测试。
 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { sourceIdentity } from "../scripts/local-overlay/files.js";
import { EditSession } from "../scripts/local-overlay/session.js";
import { Publisher } from "../scripts/local-overlay/publisher.js";

const native = vi.hoisted(() => ({
  windowsReplace: vi.fn(),
  windowsCleanup: vi.fn(),
}));
vi.mock("../scripts/local-overlay/windows-publish.js", () => native);
const windows = it.runIf(process.platform === "win32");

beforeEach(() => {
  native.windowsReplace
    .mockReset()
    .mockImplementation(async (target: string, temporary: string) => {
      await copyFile(target, temporary + ".backup");
      await rename(temporary, target);

      return "1:2";
    });
  native.windowsCleanup
    .mockReset()
    .mockImplementation(async (backup: string) => unlink(backup));
});

async function fixture() {
  const directory = await temp();
  const source = path.join(directory, "source");
  await mkdir(source);
  await writeFile(path.join(source, "file.txt"), "old\n");
  const identity = await sourceIdentity(source);
  const session = new EditSession(identity);
  await session.read("file.txt");
  await session.edit("file.txt", Buffer.from("new\n"));

  return {
    source,
    batch: session.seal(),
    publisher: new Publisher(path.join(directory, "publisher")),
  };
}

windows(
  "confirms the entire journal before removing the verified backup",
  async () => {
    const f = await fixture();
    native.windowsCleanup.mockImplementationOnce(async (backup: string) => {
      expect((await f.publisher.inspect(f.batch)).state).toBe("complete");
      expect(await readFile(backup, "utf8")).toBe("old\n");
      await unlink(backup);
    });
    const result = await f.publisher.publish(f.batch, {
      nativeWindows: true,
      validate: async () => {},
    });
    expect(result.cleanupPending).toBe(0);
    expect(await readdir(f.source)).toEqual(["file.txt"]);
    expect(await readFile(path.join(f.source, "file.txt"), "utf8")).toBe(
      "new\n",
    );
    const journal = JSON.parse(
      await readFile(path.join(result.directory, "journal.json"), "utf8"),
    );
    expect(journal.state).toBe("complete");
    expect(journal.entries[0].backup.cleaned).toBe(true);
  },
);

windows(
  "retains a cleanup conflict without rewriting a completed publication as aborted",
  async () => {
    const f = await fixture();
    native.windowsCleanup.mockRejectedValueOnce(
      new Error("Backup identity changed"),
    );
    const result = await f.publisher.publish(f.batch, {
      nativeWindows: true,
      validate: async () => {},
    });
    expect(result.cleanupPending).toBe(1);
    expect((await f.publisher.inspect(f.batch)).state).toBe("complete");
    expect(await readFile(path.join(f.source, "file.txt"), "utf8")).toBe(
      "new\n",
    );
    expect(
      (await readdir(f.source)).some((name) => name.endsWith(".backup")),
    ).toBe(true);
  },
);

windows(
  "keeps original backup and unknown journal after write acknowledgement is lost",
  async () => {
    const f = await fixture();
    await expect(
      f.publisher.publish(f.batch, {
        nativeWindows: true,
        validate: async () => {},
        afterWrite: async () => {
          throw new Error("Acknowledgement lost");
        },
      }),
    ).rejects.toThrow("Acknowledgement lost");
    expect((await f.publisher.inspect(f.batch)).state).toBe("unknown");
    const backup = (await readdir(f.source)).find((name) =>
      name.endsWith(".backup"),
    );
    expect(backup).toBeDefined();
    expect(await readFile(path.join(f.source, backup!), "utf8")).toBe("old\n");
    await expect(
      f.publisher.publish(f.batch, {
        nativeWindows: true,
        lockTimeoutMs: 10,
        validate: async () => {},
      }),
    ).rejects.toThrow("LOCK_BUSY_OR_RECOVERY_REQUIRED");
  },
);

windows(
  "never falls back to an ordinary rename after native rejection",
  async () => {
    const f = await fixture();
    native.windowsReplace.mockRejectedValueOnce(new Error("Native refused"));
    await expect(
      f.publisher.publish(f.batch, {
        nativeWindows: true,
        validate: async () => {},
      }),
    ).rejects.toThrow("Native refused");
    expect(await readFile(path.join(f.source, "file.txt"), "utf8")).toBe(
      "old\n",
    );
    expect((await f.publisher.inspect(f.batch)).state).toBe("unknown");
    expect(
      (await readdir(f.source)).some((name) => name.endsWith(".tmp")),
    ).toBe(true);
  },
);

it.each([true, false])(
  "records view refresh independently from source commit: %s",
  async (success) => {
    const f = await fixture();
    const request = {
      batchId: f.batch.id,
      seal: randomUUID(),
      epoch: 0,
      paths: ["\\file.txt"],
    };
    const result = await f.publisher.publish(f.batch, {
      validate: async () => {},
      refresh: {
        request,
        acknowledge: async () => {
          expect((await f.publisher.inspect(f.batch)).state).toBe("complete");
          expect(await readFile(path.join(f.source, "file.txt"), "utf8")).toBe(
            "new\n",
          );
          if (!success) {
            throw new Error("Refresh receipt lost");
          }
        },
      },
    });
    expect(result.refreshPending).toBe(!success);
    const journal = JSON.parse(
      await readFile(path.join(result.directory, "journal.json"), "utf8"),
    );
    expect(journal.state).toBe("complete");
    expect(journal.refresh).toEqual({
      request,
      state: success ? "confirmed" : "pending",
    });
    await expect(
      f.publisher.publish(f.batch, { validate: async () => {} }),
    ).rejects.toThrow();
  },
);

it("rejects an invalid refresh request before source publication", async () => {
  const f = await fixture();
  await expect(
    f.publisher.publish(f.batch, {
      validate: async () => {},
      refresh: {
        request: {
          batchId: f.batch.id,
          seal: randomUUID(),
          epoch: -1,
          paths: ["\\file.txt"],
        },
        acknowledge: async () => {},
      },
    }),
  ).rejects.toThrow();
  expect(await readFile(path.join(f.source, "file.txt"), "utf8")).toBe("old\n");
});

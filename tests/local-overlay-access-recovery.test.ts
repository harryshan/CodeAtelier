/**
 * Local 与 Sandbox 启动 ACL 恢复的生命周期回归，真实清单/目录配合假文件系统。
 * 1. 原生退出证明替身仅隔离平台依赖；验证原私有卷在撤销回调期间存在，结束后关闭。
 * 2. 原清单、任务锁和来源字节必须保持；恢复不使旧任务可运行。
 * 3. 回调失败仍关闭；活动卷、身份改变、退出证明失败不得调用撤销动作。
 * 安装态退出和 Windows ACL 撤销由手动 server-crash verifier 覆盖。
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { withLocalInspection } from "../src/local-overlays/inspection-lease.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";
import { TestStore } from "./fixtures/managed-runtime.js";

vi.mock("../src/local-overlays/inspection-lease.js", () => ({
  withLocalInspection: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(withLocalInspection).mockReset();
  vi.mocked(withLocalInspection).mockImplementation(
    async (_control, signal, operation) => operation(signal),
  );
});

async function fixture() {
  const directory = await temp();
  const source = await temp();
  await writeFile(path.join(source, "source.txt"), "source");
  const backend = new FakeLocalOverlayBackend(await temp());
  const service = new LocalOverlayService(
    directory,
    pino({ enabled: false }),
    backend,
  );
  const store = new TestStore(path.join(directory, "history.sqlite"));
  const id = randomUUID();
  const session = await service.create({ id, source }, async (workspace) =>
    store.create(workspace),
  );
  const file = path.join(service.root, `${id}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.phase = "active";
  record.taskId = randomUUID();
  await writeFile(file, JSON.stringify(record));
  const lock = path.join(service.root, `${id}.lock`);
  await writeFile(lock, "", { flag: "wx" });

  return { service, backend, session, id, file, lock, source, record };
}

it("keeps the old view mounted only during ACL revocation without resuming it", async () => {
  const f = await fixture();
  const before = await readFile(f.file);
  let revoked = false;
  await f.service.withSandboxRecoveryRoots(
    [f.session.workspace],
    new AbortController().signal,
    async () => {
      expect(f.backend.mounted.has(f.id)).toBe(true);
      revoked = true;
    },
  );
  expect(revoked).toBe(true);
  expect(f.backend.mounted.size).toBe(0);
  expect(await readFile(f.file)).toEqual(before);
  expect(await readFile(f.lock, "utf8")).toBe("");
  expect(await readFile(path.join(f.source, "source.txt"), "utf8")).toBe(
    "source",
  );
  await expect(
    f.service.validate(f.session.workspace, f.session.id),
  ).rejects.toThrow();
});

it("closes the temporary view when native revocation fails and preserves the task lock", async () => {
  const f = await fixture();
  await expect(
    f.service.withSandboxRecoveryRoots(
      [f.session.workspace],
      new AbortController().signal,
      async () => {
        throw new Error("native revoke failed");
      },
    ),
  ).rejects.toThrow("native revoke failed");
  expect(f.backend.mounted.size).toBe(0);
  expect(await readFile(f.lock, "utf8")).toBe("");
});

it.each(["identity", "owner"])(
  "refuses %s failure before mounting or revoking",
  async (failure) => {
    const f = await fixture();
    if (failure === "identity") {
      f.record.controlIdentity = "different";
      await writeFile(f.file, JSON.stringify(f.record));
    } else {
      vi.mocked(withLocalInspection).mockRejectedValue(
        new Error("old owner lives"),
      );
    }

    let revoked = false;
    await expect(
      f.service.withSandboxRecoveryRoots(
        [f.session.workspace],
        new AbortController().signal,
        async () => {
          revoked = true;
        },
      ),
    ).rejects.toThrow();
    expect(revoked).toBe(false);
    expect(f.backend.mounted.size).toBe(0);
  },
);

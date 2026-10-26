/**
 * 候选卷持久 ACL 恢复记录的回归，真实文件身份/记录配合假挂载和退出证明。
 * 1. 保存后可在新实例读取；恢复只在撤销期间挂载，不删除记录或私有证据。
 * 2. 缺失/损坏/过大记录、目录或卷身份改变、活 owner 与检查期间替换均阻止撤销。
 * 3. 撤销失败仍卸载；正常清理只删除内容匹配的记录，未知记录不覆盖。
 * 不声称验证 Windows ACL 或进程排空，真实安装态由 server-crash 手动入口覆盖。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { CandidateAccessStore } from "../src/local-overlays/candidate-access.js";
import { withLocalInspection } from "../src/local-overlays/inspection-lease.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";

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
  const backend = new FakeLocalOverlayBackend(await temp());
  const id = randomUUID();
  const control = path.join(directory, id);
  await mkdir(control);
  await mkdir(backend.workspace(id));
  await writeFile(path.join(control, "evidence"), "partial");
  const store = new CandidateAccessStore(directory);
  const record = await store.save(id, source, backend.workspace(id));
  const file = path.join(directory, `${id}.access.json`);

  return { directory, source, backend, id, control, store, record, file };
}

it("recovers only root access from persisted identity and preserves unknown evidence", async () => {
  const f = await fixture();
  const before = await readFile(f.file);
  const fresh = new CandidateAccessStore(f.directory);
  let revoked = false;
  await fresh.recover(
    f.id,
    f.backend,
    new AbortController().signal,
    async () => {
      expect(f.backend.mounted.has(f.id)).toBe(true);
      revoked = true;
    },
  );
  expect(revoked).toBe(true);
  expect(f.backend.mounted.size).toBe(0);
  expect(await readFile(f.file)).toEqual(before);
  expect(await readFile(path.join(f.control, "evidence"), "utf8")).toBe(
    "partial",
  );
  await expect(
    f.store.save(f.id, f.source, f.backend.workspace(f.id)),
  ).rejects.toThrow();
});

it.each([
  "sourceIdentity",
  "storageIdentity",
  "controlIdentity",
  "workspaceIdentity",
  "id",
  "version",
])("refuses changed %s without granting revocation", async (field) => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ ...f.record, [field]: "changed" }));
  let revoked = false;
  await expect(
    f.store.recover(f.id, f.backend, new AbortController().signal, async () => {
      revoked = true;
    }),
  ).rejects.toThrow();
  expect(revoked).toBe(false);
  expect(f.backend.mounted.size).toBe(0);
});

it.each(["malformed", "oversized", "owner", "changed-during-proof"])(
  "fails closed for %s",
  async (failure) => {
    const f = await fixture();
    if (failure === "malformed" || failure === "oversized") {
      await writeFile(
        f.file,
        failure === "malformed" ? "{" : "x".repeat(65537),
      );
    } else if (failure === "owner") {
      vi.mocked(withLocalInspection).mockRejectedValue(
        new Error("owner alive"),
      );
    } else {
      vi.mocked(withLocalInspection).mockImplementation(async () => {
        await writeFile(
          f.file,
          JSON.stringify({ ...f.record, workspaceIdentity: "changed" }),
        );
      });
    }

    let revoked = false;
    await expect(
      f.store.recover(
        f.id,
        f.backend,
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

it("closes on revoke failure and removes only the exact owned record", async () => {
  const f = await fixture();
  await expect(
    f.store.recover(f.id, f.backend, new AbortController().signal, async () => {
      throw new Error("revoke failed");
    }),
  ).rejects.toThrow("revoke failed");
  expect(f.backend.mounted.size).toBe(0);
  await expect(
    f.store.remove({ ...f.record, workspaceIdentity: "changed" }),
  ).rejects.toThrow();
  await f.store.remove(f.record);
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    f.store.recover(
      f.id,
      f.backend,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow();
});

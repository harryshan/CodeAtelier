/**
 * POSIX 观察清单到 Publisher 批次的文件系统回归；不模拟内核挂载成功。
 * 1. fixture 用真实文件身份/版本生成 helper 格式记录，普通目录模拟已排空的视图。
 * 2. 验证捕获原文、明确选集、未读正文补读、来源/目录依赖过期及损坏对象拒绝。
 * 3. 真实 Publisher 验证三方合并、同一行冲突和私有修改保留；候选回调只检查合并结果。
 * 原生 seal、真实 Runtime 与候选执行由独立 WSL 手动实验验证，不把本测试当 Sandbox 证据。
 */
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { posixBatch } from "../src/local-overlays/posix-batch.js";
import {
  sourceIdentity,
  snapshot,
} from "../src/local-overlays/publication/files.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

const original = "a = 1\nb = 2\n";

async function record(root: string, file: string) {
  const info = await lstat(path.join(root, file), { bigint: true });
  const identity = `${info.dev}:${info.ino}`;

  return {
    path: file,
    kind: info.isDirectory() ? ("directory" as const) : ("file" as const),
    identity,
    stamp: `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`,
    mode: Number(info.mode),
    links: Number(info.nlink),
    object: null as string | null,
    objectStamp: null as string | null,
    members: null as string[] | null,
  };
}

async function fixture(captured = true) {
  const root = await temp();
  const sourcePath = path.join(root, "source");
  const control = path.join(root, "control");
  const workspace = path.join(root, "view");
  for (const directory of [sourcePath, control, workspace]) {
    await mkdir(directory);
  }

  await writeFile(path.join(sourcePath, "code.py"), original);
  await writeFile(path.join(sourcePath, "dep.txt"), "dependency\n");
  await copyFile(
    path.join(sourcePath, "code.py"),
    path.join(workspace, "code.py"),
  );
  const source = await sourceIdentity(sourcePath);
  const directory = await record(source.root, ".");
  directory.members = ["code.py\0f", "dep.txt\0f"];
  const code = await record(source.root, "code.py");
  if (captured) {
    await copyFile(
      path.join(source.root, "code.py"),
      path.join(control, "object-1"),
    );
    code.object = "object-1";
    code.objectStamp = (await record(control, "object-1")).stamp;
  }

  const dependency = await record(source.root, "dep.txt");
  const sealId = randomUUID();
  const manifest = {
    version: 1,
    id: sealId,
    source,
    entries: [directory, code, dependency],
  };
  const save = () =>
    writeFile(path.join(control, sealId + ".json"), JSON.stringify(manifest));
  await save();
  const input = { source, control, workspace, sealId, selected: ["code.py"] };

  return { root, input, manifest, save };
}

it("keeps captured B and publishes disjoint changes through the real coordinator", async () => {
  const f = await fixture();
  const before = await snapshot(f.input.source, "code.py");
  await writeFile(path.join(f.input.workspace, "code.py"), "a = 10\nb = 2\n");
  await writeFile(path.join(f.input.workspace, "artifact"), "private");
  await writeFile(
    path.join(f.input.source.root, "replacement"),
    "a = 1\nb = 20\n",
  );
  await rename(
    path.join(f.input.source.root, "replacement"),
    path.join(f.input.source.root, "code.py"),
  );
  const batch = await posixBatch(f.input);
  expect(batch.changes).toHaveLength(1);
  expect(batch.changes[0]?.base).toEqual(before);
  await new Publisher(path.join(f.root, "publications")).publish(batch, {
    validate: async (files) => {
      expect(files.get("code.py")?.toString()).toBe("a = 10\nb = 20\n");
    },
  });
  expect(
    await readFile(path.join(f.input.source.root, "code.py"), "utf8"),
  ).toBe("a = 10\nb = 20\n");
  expect(await readdir(f.input.source.root)).not.toContain("artifact");
  expect(await readFile(path.join(f.input.workspace, "artifact"), "utf8")).toBe(
    "private",
  );
});

it("retains private content when the coordinator detects overlapping edits", async () => {
  const f = await fixture();
  await writeFile(path.join(f.input.workspace, "code.py"), "a = 10\nb = 2\n");
  await writeFile(path.join(f.input.source.root, "code.py"), "a = 99\nb = 2\n");
  const batch = await posixBatch(f.input);
  await expect(
    new Publisher(path.join(f.root, "publications")).publish(batch, {
      validate: async () => {
        throw new Error("Must reject before validation");
      },
    }),
  ).rejects.toMatchObject({ reason: "TEXT_CONFLICT", outcome: "unapplied" });
  expect(await readFile(path.join(f.input.workspace, "code.py"), "utf8")).toBe(
    "a = 10\nb = 2\n",
  );
  expect(
    await readFile(path.join(f.input.source.root, "code.py"), "utf8"),
  ).toBe("a = 99\nb = 2\n");
});

it("recovers uncaptured bytes only while the observed source version is unchanged", async () => {
  const f = await fixture(false);
  await writeFile(path.join(f.input.workspace, "code.py"), "private\n");
  expect((await posixBatch(f.input)).changes[0]?.base).toEqual(
    await snapshot(f.input.source, "code.py"),
  );
  await writeFile(path.join(f.input.source.root, "code.py"), "later\n");
  await expect(posixBatch(f.input)).rejects.toThrow("STALE_DEPENDENCY");
});

it.each(["file", "directory"])(
  "rejects stale %s dependencies",
  async (kind) => {
    const f = await fixture();
    await writeFile(path.join(f.input.workspace, "code.py"), "private\n");
    await writeFile(
      path.join(f.input.source.root, kind === "file" ? "dep.txt" : "new.txt"),
      "later\n",
    );
    await expect(posixBatch(f.input)).rejects.toThrow("STALE_DEPENDENCY");
  },
);

it("exports creation only from an observed absence and exports deletion from B", async () => {
  const f = await fixture();
  await unlink(path.join(f.input.workspace, "code.py"));
  await writeFile(path.join(f.input.workspace, "new.txt"), "new\n");
  const batch = await posixBatch({
    ...f.input,
    selected: ["code.py", "new.txt"],
  });
  expect(batch.changes[0]?.ours).toBeNull();
  expect(batch.changes[1]?.base).toEqual({
    content: null,
    version: "missing",
    mode: null,
  });
  f.manifest.entries[0]!.members = null;
  await f.save();
  await expect(
    posixBatch({ ...f.input, selected: ["new.txt"] }),
  ).rejects.toThrow("POSIX_BASELINE_MISSING");
});

it("rejects captured object changes without replacing the original version", async () => {
  const f = await fixture();
  await writeFile(path.join(f.input.control, "object-1"), "altered\n");
  await expect(posixBatch(f.input)).rejects.toThrow("POSIX_OBJECT_CHANGED");
});

it("keeps selected but unchanged files as read dependencies", async () => {
  const f = await fixture();
  await writeFile(path.join(f.input.workspace, "new.txt"), "new\n");
  await writeFile(path.join(f.input.source.root, "code.py"), "later\n");
  await expect(
    posixBatch({ ...f.input, selected: ["code.py", "new.txt"] }),
  ).rejects.toThrow("STALE_DEPENDENCY");
});

it("rejects mismatched source records and duplicate selected paths", async () => {
  const f = await fixture();
  await writeFile(path.join(f.input.workspace, "code.py"), "private\n");
  await expect(
    posixBatch({ ...f.input, selected: ["code.py", "code.py"] }),
  ).rejects.toThrow("DUPLICATE_PATH");
  f.manifest.source = { ...f.input.source, identity: "0:0" };
  await f.save();
  await expect(posixBatch(f.input)).rejects.toThrow("SOURCE_REPLACED");
});

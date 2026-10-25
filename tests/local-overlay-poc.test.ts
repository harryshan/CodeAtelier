/**
 * Local overlay 文件发布 PoC 的真实文件回归；不依赖 Git、WinFsp 或个人项目。
 * 1. 纯合并用例检查行边界、EOF、二进制和存在性冲突，避免“无报错”被误当正确整合。
 * 2. 会话用例核对陈旧读取拒绝、私有修改与整批预检；发布用例检查并发最终文件内容。
 * 3. 验证期间变动、取消和写后异常检查来源、备份日志与未知锁，恢复只读观察。
 * 4. 路径替换、管理目录与重复批次拒绝；trace 不含路径或正文。
 * 临时目录由既有 TestResources 清理；真实进程强退与跨进程锁另由手动脚本验证。
 */
import {
  mkdir,
  readFile,
  writeFile,
  symlink,
  readdir,
  link,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { mergeContent } from "../src/local-overlays/publication/merge.js";
import {
  bytes,
  snapshot,
  sourceIdentity,
} from "../src/local-overlays/publication/files.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

const buffer = (value: string | null) =>
  value === null ? null : Buffer.from(value);
const validate = async () => {};

it.each([
  ["a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "A\nb\nC\n"],
  ["a\nb\n", "A\nb\n", "a\nB\n", "A\nB\n"],
  ["a\r\nb\r\nc", "A\r\nb\r\nc", "a\r\nb\r\nC", "A\r\nb\r\nC"],
  ["a\nb\nc\n", "A\nb\nc\n", "A\nb\nC\n", "A\nb\nC\n"],
  [
    "a\nb\nc\n",
    "a\nours\nb\nc\n",
    "a\nb\nc\ntheirs\n",
    "a\nours\nb\nc\ntheirs\n",
  ],
  [null, "created", null, "created"],
  ["delete", null, "delete", null],
  ["old", "same", "same", "same"],
  ["\uFEFFa\nb\nc", "\uFEFFA\nb\nc", "\uFEFFa\nb\nC", "\uFEFFA\nb\nC"],
])(
  "merges exact bytes for disjoint changes %#",
  (base, ours, theirs, expected) => {
    expect(mergeContent(buffer(base), buffer(ours), buffer(theirs))).toEqual(
      buffer(expected),
    );
  },
);

it.each([
  ["a\nb", "A\nb", "OTHER\nb"],
  ["a\nb\n", "a\nx\nb\n", "a\ny\nb\n"],
  ["a\nb\n", "A\nb\n", "insert\na\nb\n"],
  ["file", null, "modified"],
  [null, "ours", "theirs"],
  ["file", "modified", null],
  ["\0a", "\0b", "\0c"],
])("refuses overlapping or ambiguous changes %#", (base, ours, theirs) => {
  expect(() =>
    mergeContent(buffer(base), buffer(ours), buffer(theirs)),
  ).toThrow();
});

it("merges disjoint substitutions symmetrically across deterministic line pairs", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line-${index}\n`);
  for (let first = 0; first < lines.length; first++) {
    for (let second = first + 1; second < lines.length; second++) {
      const ours = [...lines];
      const theirs = [...lines];
      const expected = [...lines];
      ours[first] = expected[first] = "ours\n";
      theirs[second] = expected[second] = "theirs\n";
      for (const pair of [
        [ours, theirs],
        [theirs, ours],
      ]) {
        expect(
          mergeContent(
            buffer(lines.join("")),
            buffer(pair[0]!.join("")),
            buffer(pair[1]!.join("")),
          ),
        ).toEqual(buffer(expected.join("")));
      }
    }
  }
});

async function fixture() {
  const root = await temp();
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "one.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(source, "two.txt"), "second\n");
  const identity = await sourceIdentity(source);
  const publisher = new Publisher(path.join(root, "coordinator"));

  return {
    root,
    source,
    identity,
    publisher,
    session: () => new EditSession(identity),
    read: (name = "one.txt") => readFile(path.join(source, name), "utf8"),
  };
}

async function edit(
  session: EditSession,
  name: string,
  content: string | null,
) {
  await session.read(name);
  await session.edit(name, buffer(content));
}

it("keeps private edits off the source and refuses stale first edits", async () => {
  const f = await fixture();
  const stale = f.session();
  await stale.read("one.txt");
  await writeFile(path.join(f.source, "one.txt"), "external\n");
  await expect(stale.edit("one.txt", buffer("stale\n"))).rejects.toThrow(
    "STALE_READ",
  );
  const active = f.session();
  const read = await active.read("one.txt");
  read!.fill(0);
  await active.edit("one.txt", buffer("private\n"));
  expect(await f.read()).toBe("external\n");
  expect(bytes(active.seal().changes[0]!.base)?.toString()).toBe("external\n");
  expect((await active.read("one.txt"))?.toString()).toBe("private\n");
});

it("serializes concurrent independent changes without losing either publication", async () => {
  const f = await fixture();
  const first = f.session();
  const second = f.session();
  await edit(first, "one.txt", "A\n");
  await edit(second, "two.txt", "B\n");
  await Promise.all([
    f.publisher.publish(first.seal(), { validate }),
    new Publisher(f.publisher.directory).publish(second.seal(), { validate }),
  ]);
  expect(await f.read()).toBe("A\n");
  expect(await f.read("two.txt")).toBe("B\n");
});

it("validates the merged candidate and publishes both sessions' disjoint edits", async () => {
  const f = await fixture();
  const first = f.session();
  const second = f.session();
  await edit(first, "one.txt", "ONE\ntwo\nthree\n");
  await edit(second, "one.txt", "one\ntwo\nTHREE\n");
  await f.publisher.publish(first.seal(), { validate });
  const published = await f.publisher.publish(second.seal(), {
    validate: async (files) => {
      expect(files.get("one.txt")?.toString()).toBe("ONE\ntwo\nTHREE\n");
    },
  });
  expect(await f.read()).toBe("ONE\ntwo\nTHREE\n");
  const trace = await readFile(
    path.join(published.directory, "trace.json"),
    "utf8",
  );
  expect(trace).toContain("local_overlay.validate");
  expect(trace).not.toContain(f.source.replaceAll("\\", "\\\\"));
  expect(trace).not.toContain("THREE");
  await expect(
    f.publisher.publish(second.seal(), { validate }),
  ).rejects.toThrow();
  expect(await f.read()).toBe("ONE\ntwo\nTHREE\n");
});

it("preflights the entire batch before any conflicting batch changes become visible", async () => {
  const f = await fixture();
  const first = f.session();
  const second = f.session();
  await edit(first, "one.txt", "winner\n");
  await edit(second, "two.txt", "must stay private\n");
  await edit(second, "one.txt", "conflict\n");
  await f.publisher.publish(first.seal(), { validate });
  await expect(
    f.publisher.publish(second.seal(), { validate }),
  ).rejects.toThrow("TEXT_CONFLICT");
  expect(await f.read()).toBe("winner\n");
  expect(await f.read("two.txt")).toBe("second\n");
});

it("rejects stale read-only dependencies and invalidated validation candidates", async () => {
  const f = await fixture();
  const reader = f.session();
  await reader.read("two.txt");
  await edit(reader, "one.txt", "derived\n");
  await writeFile(path.join(f.source, "two.txt"), "dependency changed\n");
  await expect(
    f.publisher.publish(reader.seal(), { validate }),
  ).rejects.toThrow("STALE_DEPENDENCY");
  expect(await f.read()).toBe("one\ntwo\nthree\n");
  const racing = f.session();
  await edit(racing, "one.txt", "candidate\n");
  await expect(
    f.publisher.publish(racing.seal(), {
      validate: async () => {
        await writeFile(
          path.join(f.source, "one.txt"),
          "external while validating\n",
        );
      },
    }),
  ).rejects.toThrow("STALE_CANDIDATE");
  expect(await f.read()).toBe("external while validating\n");
});

it("retains partial publication and refuses blind replay after an unknown write", async () => {
  const f = await fixture();
  const session = f.session();
  await edit(session, "one.txt", "first written\n");
  await edit(session, "two.txt", "second private\n");
  const batch = session.seal();
  await expect(
    f.publisher.publish(batch, {
      validate,
      afterWrite: async () => {
        throw new Error("simulated lost acknowledgement");
      },
    }),
  ).rejects.toThrow("lost acknowledgement");
  expect(await f.read()).toBe("first written\n");
  expect(await f.read("two.txt")).toBe("second\n");
  expect(await f.publisher.inspect(batch)).toEqual({
    state: "unknown",
    files: [
      { path: "one.txt", recorded: "intent", observed: "matches_after" },
      { path: "two.txt", recorded: "pending", observed: "matches_before" },
    ],
  });
  await writeFile(path.join(f.source, "one.txt"), "later external edit\n");
  expect((await f.publisher.inspect(batch)).files[0]!.observed).toBe(
    "diverged",
  );
  await expect(
    f.publisher.publish(batch, { validate, lockTimeoutMs: 40 }),
  ).rejects.toThrow("RECOVERY_REQUIRED");
  expect(await f.read()).toBe("later external edit\n");
});

it("cancels before mutation and allows a fresh publication without reusing a batch", async () => {
  const f = await fixture();
  const session = f.session();
  await edit(session, "one.txt", "cancelled\n");
  const controller = new AbortController();
  await expect(
    f.publisher.publish(session.seal(), {
      signal: controller.signal,
      validate: async (_files, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect(await f.read()).toBe("one\ntwo\nthree\n");
  expect((await f.publisher.inspect(session.seal())).state).toBe("aborted");
  const next = f.session();
  await edit(next, "one.txt", "fresh\n");
  await f.publisher.publish(next.seal(), { validate });
  expect(await f.read()).toBe("fresh\n");
});

it("stops before the next file when cancellation follows a completed write", async () => {
  const f = await fixture();
  const session = f.session();
  await edit(session, "one.txt", "first published\n");
  await edit(session, "two.txt", "second private\n");
  const controller = new AbortController();
  const batch = session.seal();
  await expect(
    f.publisher.publish(batch, {
      validate,
      signal: controller.signal,
      afterWrite: async () => controller.abort(new Error("Lease lost")),
    }),
  ).rejects.toMatchObject({ message: "Lease lost", outcome: "unknown" });
  expect(await f.read()).toBe("first published\n");
  expect(await f.read("two.txt")).toBe("second\n");
  expect(await f.publisher.inspect(batch)).toEqual({
    state: "unknown",
    files: [
      { path: "one.txt", recorded: "written", observed: "matches_after" },
      { path: "two.txt", recorded: "pending", observed: "matches_before" },
    ],
  });
  await expect(
    f.publisher.publish(batch, { validate, lockTimeoutMs: 20 }),
  ).rejects.toThrow("RECOVERY_REQUIRED");
});

it("handles file creation/deletion and rejects concurrent create or delete-versus-edit", async () => {
  const f = await fixture();
  const first = f.session();
  const second = f.session();
  await edit(first, "created.txt", "first\n");
  await edit(second, "created.txt", "second\n");
  await f.publisher.publish(first.seal(), { validate });
  await expect(
    f.publisher.publish(second.seal(), { validate }),
  ).rejects.toThrow("EXISTENCE_CONFLICT");
  expect(await f.read("created.txt")).toBe("first\n");
  const deleting = f.session();
  await edit(deleting, "one.txt", null);
  await writeFile(path.join(f.source, "one.txt"), "modified\n");
  await expect(
    f.publisher.publish(deleting.seal(), { validate }),
  ).rejects.toThrow("EXISTENCE_CONFLICT");
  const cleanDelete = f.session();
  await edit(cleanDelete, "two.txt", null);
  await f.publisher.publish(cleanDelete.seal(), { validate });
  await expect(f.read("two.txt")).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a failed candidate validation without changing source or retaining the lock", async () => {
  const f = await fixture();
  const session = f.session();
  await edit(session, "one.txt", "invalid candidate\n");
  await expect(
    f.publisher.publish(session.seal(), {
      validate: async () => {
        throw new Error("candidate check failed");
      },
    }),
  ).rejects.toMatchObject({
    message: "candidate check failed",
    outcome: "unapplied",
    reason: "VALIDATION_FAILED",
  });
  expect(await f.read()).toBe("one\ntwo\nthree\n");
  expect((await f.publisher.inspect(session.seal())).state).toBe("aborted");

  const corrected = f.session();
  await edit(corrected, "one.txt", "validated\n");
  await f.publisher.publish(corrected.seal(), { validate });
  expect(await f.read()).toBe("validated\n");
});

it("refuses a parent replaced by a junction during validation without modifying its target", async () => {
  const f = await fixture();
  const parent = path.join(f.source, "nested");
  const original = path.join(f.source, "original");
  const outside = path.join(f.root, "outside");
  await mkdir(parent);
  await mkdir(outside);
  await writeFile(path.join(parent, "file.txt"), "original\n");
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const session = f.session();
  await edit(session, "nested/file.txt", "private\n");

  await expect(
    f.publisher.publish(session.seal(), {
      validate: async () => {
        await rename(parent, original);
        await symlink(
          outside,
          parent,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    }),
  ).rejects.toThrow("PATH_REPLACED");
  expect(await readFile(path.join(outside, "file.txt"), "utf8")).toBe(
    "outside\n",
  );
  expect(await readFile(path.join(original, "file.txt"), "utf8")).toBe(
    "original\n",
  );
});

it("refuses path escapes, source aliases, management state and duplicate names", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  await symlink(
    outside,
    path.join(f.source, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const name of [
    "../outside/secret.txt",
    "alias/secret.txt",
    ".git/config",
    ".CODEATELIER-PUBLISH-private.tmp",
    "one.txt:stream",
    "CON",
    "/absolute",
  ]) {
    await expect(f.session().read(name)).rejects.toThrow();
  }

  await link(path.join(f.source, "one.txt"), path.join(f.source, "hard.txt"));
  await expect(snapshot(f.identity, "hard.txt")).rejects.toThrow(
    "FILE_TYPE_OR_LIMIT",
  );
  const session = f.session();
  await edit(session, "two.txt", "safe\n");
  const batch = session.seal();
  batch.changes.push({ ...batch.changes[0]!, path: "TWO.txt" });
  await expect(f.publisher.publish(batch, { validate })).rejects.toThrow(
    "DUPLICATE_PATH",
  );
  expect(await f.read("two.txt")).toBe("second\n");
  await expect(
    new Publisher(path.join(f.source, "control")).publish(session.seal(), {
      validate,
    }),
  ).rejects.toThrow("CONTROL_OVERLAP");
  expect(await readdir(f.source)).not.toContain("control");
});

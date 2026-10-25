/**
 * 候选验证凭据及发布门槛回归；使用真实 SQLite/文件，不模拟 WinFsp 或声称 Sandbox 已通过。
 * 1. 原生夹具证明新读取在采样后仍须匹配 helper 观察，测试修改候选内容必须拒绝。
 * 2. Publisher 真实来源用例证明新增依赖失效阻止全部发布，正常凭据写入 journal。
 * 3. 排空未知保持 unknown 分类；路径/重复项/数量/版本边界独立校验。
 * 实机挂载、实际进程模式与取消排空由独立候选 verifier 覆盖。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { temp } from "./fixtures/helpers.js";
import {
  candidateReads,
  CandidateCleanupUnknownError,
  validateReceipt,
} from "../src/local-overlays/candidate-reads.js";
import {
  snapshot,
  sourceIdentity,
} from "../src/local-overlays/publication/files.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

it("captures new candidate dependencies and requires native observation proof", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "merged");
  await writeFile(path.join(f.source.root, "dep.txt"), "dependency");
  f.mutate("INSERT INTO observations VALUES('\\DEP.TXT','\\dep.txt',0)");
  const selected = new Map([["code.txt", Buffer.from("merged")]]);
  const receipt = await candidateReads(
    f.source,
    f.control,
    selected,
    async () => {
      f.mutate("INSERT INTO checked_reads VALUES('\\DEP.TXT',1,0)");
    },
  );
  expect(receipt.reads).toEqual([
    { path: "dep.txt", version: (await snapshot(f.source, "dep.txt")).version },
  ]);
  await expect(
    candidateReads(f.source, f.control, selected, async () => {
      f.mutate("UPDATE checked_reads SET valid=0");
    }),
  ).rejects.toThrow("STALE_VALIDATION_DEPENDENCY");
});

it.each(["repaired", null])(
  "rejects a validator that changes selected content to %s",
  async (actual) => {
    const f = await nativeFixture();
    await f.change("code.txt", "old", actual);
    await expect(
      candidateReads(
        f.source,
        f.control,
        new Map([["code.txt", Buffer.from("merged")]]),
        async () => {},
      ),
    ).rejects.toThrow("CANDIDATE_CHANGED_BY_VALIDATOR");
  },
);

it("keeps dependencies even when the validator privately modifies them", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "merged");
  await f.change("dep.txt", "dependency", "generated");
  await writeFile(path.join(f.source.root, "dep.txt"), "dependency");
  f.mutate(
    "INSERT INTO observations VALUES('\\DEP.TXT','\\dep.txt',0); INSERT INTO checked_reads VALUES('\\DEP.TXT',1,0)",
  );
  const receipt = await candidateReads(
    f.source,
    f.control,
    new Map([["code.txt", Buffer.from("merged")]]),
    async () => {},
  );
  expect(receipt.reads.map((read) => read.path)).toEqual(["dep.txt"]);
});

async function fixture() {
  const root = await temp();
  const directory = path.join(root, "source");
  await mkdir(directory);
  await writeFile(path.join(directory, "code.txt"), "original");
  await writeFile(path.join(directory, "dep.txt"), "dependency");
  const source = await sourceIdentity(directory);
  const session = new EditSession(source);
  await session.read("code.txt");
  await session.edit("code.txt", Buffer.from("selected"));

  return {
    directory,
    source,
    batch: session.seal(),
    publisher: new Publisher(path.join(root, "publish")),
  };
}

it.each([false, true])(
  "checks dependencies first discovered by candidate validation (stale=%s)",
  async (stale) => {
    const f = await fixture();
    const version = (await snapshot(f.source, "dep.txt")).version;
    const pending = f.publisher.publish(f.batch, {
      validate: async () => {
        if (stale) {
          await writeFile(path.join(f.directory, "dep.txt"), "external change");
        }

        return { reads: [{ path: "dep.txt", version }] };
      },
    });
    if (stale) {
      await expect(pending).rejects.toMatchObject({
        outcome: "unapplied",
        reason: "STALE_VALIDATION_DEPENDENCY",
      });
      expect(await readFile(path.join(f.directory, "code.txt"), "utf8")).toBe(
        "original",
      );
    } else {
      const result = await pending;
      const journal = JSON.parse(
        await readFile(path.join(result.directory, "journal.json"), "utf8"),
      );
      expect(journal.validation.reads).toEqual([{ path: "dep.txt", version }]);
      expect(await readFile(path.join(f.directory, "code.txt"), "utf8")).toBe(
        "selected",
      );
    }
  },
);

it("does not classify unconfirmed candidate cleanup as safe to resume", async () => {
  const f = await fixture();
  await expect(
    f.publisher.publish(f.batch, {
      validate: async () => {
        throw new CandidateCleanupUnknownError();
      },
    }),
  ).rejects.toMatchObject({ outcome: "unknown" });
  expect(await readFile(path.join(f.directory, "code.txt"), "utf8")).toBe(
    "original",
  );
});

it.each([
  [{ path: "../escape", version: "v" }],
  [{ path: "a", version: "" }],
  [
    { path: "a", version: "v" },
    { path: "A", version: "v" },
  ],
  Array.from({ length: 101 }, (_, i) => ({ path: `${i}`, version: "v" })),
])("rejects malformed validation receipts %#", (reads) => {
  expect(() => validateReceipt({ reads })).toThrow();
});

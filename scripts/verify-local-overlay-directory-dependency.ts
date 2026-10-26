/**
 * 手动复现并验证目录成员变化的 Local 候选依赖，使用真实 WinFsp 与生产 CandidateValidator。
 * 1. 独占普通来源目录被实际 readdir 后新增成员，旧候选必须拒绝。
 * 2. 覆盖稳定目录、私有产物/whiteout、隐藏 .git、根列表和来源成员删除/改名/类型变更。
 * 3. 生产 Publisher 复核候选卸载后的目录变化，nativeBatch 导出真实主任务目录读集。
 * 4. 夹具与报告仅留 .local，不安装驱动、不执行模型/Sandbox/Evaluation、不发布用户源码。
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import { CandidateValidator } from "../src/local-overlays/candidate-validator.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/local-overlays/winfsp-manager.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(
  path.resolve(".local/local-overlay-directory-dependency-"),
);
const source = path.join(root, "source");
await mkdir(source);
await mkdir(path.join(source, "modules"));
await writeFile(path.join(source, "edit.txt"), "base");
await writeFile(path.join(source, "modules", "one.txt"), "one");
const validator = new CandidateValidator(
  path.join(root, "candidates"),
  createLogger(root, "info"),
);
await assert.rejects(
  validator.validate(
    source,
    new Map([["edit.txt", Buffer.from("private")]]),
    async (workspace) => {
      assert.deepEqual(await readdir(path.join(workspace, "modules")), [
        "one.txt",
      ]);
      await writeFile(
        path.join(source, "modules", "two.txt"),
        "added after enumeration",
      );

      return { exitCode: 0, drained: true, sandboxApplied: false };
    },
    AbortSignal.timeout(60_000),
    false,
  ),
  { code: "STALE_VALIDATION_DEPENDENCY" },
);
const done = { exitCode: 0, drained: true, sandboxApplied: false };
const input = new Map([["edit.txt", Buffer.from("private")]]);
const signal = AbortSignal.timeout(120_000);
const stable = await validator.validate(
  source,
  input,
  async (workspace) => {
    await readdir(workspace);
    await readdir(path.join(workspace, "modules"));
    await writeFile(
      path.join(workspace, "modules", "generated.txt"),
      "private output",
    );
    await unlink(path.join(workspace, "modules", "one.txt"));
    assert.deepEqual(await readdir(path.join(workspace, "modules")), [
      "generated.txt",
      "two.txt",
    ]);
    await mkdir(path.join(source, "modules", ".git"));
    await writeFile(
      path.join(source, "modules", "one.txt"),
      "content alone is a separate dependency",
    );
    await writeFile(path.join(source, "modules", "transient"), "temporary");
    await unlink(path.join(source, "modules", "transient"));

    return done;
  },
  signal,
  false,
);
assert(
  stable.reads.some((read) => read.path === "." && read.kind === "directory"),
);
assert(
  stable.reads.some(
    (read) => read.path === "modules" && read.kind === "directory",
  ),
);
assert(
  !(await readdir(path.join(source, "modules"))).includes("generated.txt"),
);

for (const action of ["delete", "rename", "type"] as const) {
  const directory = path.join(source, action);
  await mkdir(directory);
  await writeFile(path.join(directory, "item"), "input");
  await assert.rejects(
    validator.validate(
      source,
      input,
      async (workspace) => {
        const view = path.join(workspace, action);
        assert.deepEqual(await readdir(view), ["item"]);
        if (action === "rename") {
          await rename(
            path.join(directory, "item"),
            path.join(directory, "renamed"),
          );
        } else {
          await unlink(path.join(directory, "item"));
          if (action === "type") {
            await mkdir(path.join(directory, "item"));
          }
        }

        // A newer successful list must not erase the first list in this epoch.
        await readdir(view);

        return done;
      },
      signal,
      false,
    ),
    { code: "STALE_VALIDATION_DEPENDENCY" },
  );
}

const logger = createLogger(root, "info");
const publisher = new Publisher(path.join(root, "publisher"), logger);
const edit = new EditSession(await sourceIdentity(source));
await edit.read("edit.txt");
await edit.edit("edit.txt", Buffer.from("private"));
await assert.rejects(
  publisher.publish(edit.seal(), {
    nativeWindows: true,
    validate: async (files, currentSignal) => {
      const receipt = await validator.validate(
        source,
        files,
        async (workspace) => {
          await readdir(path.join(workspace, "modules"));

          return done;
        },
        currentSignal ?? signal,
        false,
      );
      await writeFile(
        path.join(source, "modules", "late.txt"),
        "after validator drained",
      );

      return receipt;
    },
  }),
  { code: "STALE_VALIDATION_DEPENDENCY" },
);

const manager = new OverlayManager(root, logger);
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const control = path.join(root, "main-control");
try {
  await manager.start(id, source, control, workspace, true, signal, {
    kind: "local",
  });
  await readdir(workspace);
  await writeFile(path.join(workspace, "edit.txt"), "main private");
  const batch = await manager.withFrozen(id, async (verify) =>
    nativeBatch(
      await sourceIdentity(source),
      control,
      ["edit.txt"],
      verify,
      signal,
    ),
  );
  assert(
    batch.reads.some((read) => read.path === "." && read.kind === "directory"),
  );
  await writeFile(path.join(source, "main-late.txt"), "after main export");
  await assert.rejects(
    publisher.publish(batch, { nativeWindows: true, validate: async () => {} }),
    {
      code: "STALE_DEPENDENCY",
    },
  );
} finally {
  await manager.close();
}

assert.equal(await readFile(path.join(source, "edit.txt"), "utf8"), "base");
for (const round of [1, 2]) {
  const next = new EditSession(await sourceIdentity(source));
  await next.read("edit.txt");
  await next.edit("edit.txt", Buffer.from(`published ${round}`));
  const result = await publisher.publish(next.seal(), {
    nativeWindows: true,
    validate: async (files, currentSignal) =>
      validator.validate(
        source,
        files,
        async (view) => {
          await readdir(view);
          await readdir(path.join(view, "modules"));

          return done;
        },
        currentSignal ?? signal,
        false,
      ),
  });
  assert.equal(result.files, 1);
  assert.equal(result.cleanupPending, 0);
  assert.equal(
    await readFile(path.join(source, "edit.txt"), "utf8"),
    `published ${round}`,
  );
}

assert(
  !(await readdir(path.join(root, "candidates"))).some((name) =>
    /^[a-f0-9-]{36}$/.test(name),
  ),
);
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      checks: [
        "addition after enumeration rejects old candidate",
        "stable root and child directory exported",
        "private output and whiteout excluded from source membership",
        "content-only writes and removed temporary names do not invalidate membership",
        "hidden .git excluded",
        "delete rename and type changes reject despite later enumeration",
        "post-candidate membership change refuses publication",
        "main directory batch rechecked before publication",
        "refusals preserve source and candidate volumes reclaimed",
        "stable directory validation supports consecutive native publications",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`LOCAL_DIRECTORY_DEPENDENCY PASS root=${root}\n`);

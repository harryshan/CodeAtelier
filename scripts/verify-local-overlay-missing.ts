/**
 * 手动验证 Local 的缺失路径依赖，使用真实 WinFsp 与生产候选验证器，不启动模型或 Sandbox。
 * 1. 独占普通来源夹具中检查文件不存在，然后由宿主创建；旧候选必须拒绝，不能仅检查读过的正文。
 * 2. 覆盖稳定缺失、缺失父目录、首次观察、编辑前保护、隐藏名称与私有 whiteout。
 * 3. 真实 nativeBatch 导出及 Publisher 在候选卸载后再次检查缺失版本，来源新增必须阻止写入。
 * 4. 失败保留日志与夹具，成功保存报告；不安装驱动、不发布到用户来源、不进入默认检查/Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import { CandidateValidator } from "../src/local-overlays/candidate-validator.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/local-overlays/winfsp-manager.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-missing-"));
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "edit.txt"), "base");
await mkdir(path.join(source, ".git"));
await writeFile(
  path.join(source, "hidden.txt"),
  "lower survives private deletion",
);
const log = createLogger(root, "info");
const candidateRoot = path.join(root, "candidates");
const validator = new CandidateValidator(candidateRoot, log);
const publisher = new Publisher(path.join(root, "publisher"), log);
const signal = AbortSignal.timeout(60_000);
const input = new Map([["edit.txt", Buffer.from("private")]]);
const done = { exitCode: 0, drained: true, sandboxApplied: false };

await assert.rejects(
  validator.validate(
    source,
    input,
    async (workspace) => {
      await assert.rejects(stat(path.join(workspace, "optional.json")), {
        code: "ENOENT",
      });
      await writeFile(path.join(source, "optional.json"), "new dependency");
      assert.equal(
        await readFile(path.join(workspace, "optional.json"), "utf8"),
        "new dependency",
      );
      await assert.rejects(
        writeFile(path.join(workspace, "optional.json"), "unsafe edit"),
      );

      return done;
    },
    signal,
    false,
  ),
  { code: "STALE_VALIDATION_DEPENDENCY" },
);
assert.equal(
  await readFile(path.join(source, "optional.json"), "utf8"),
  "new dependency",
);

const stable = await validator.validate(
  source,
  input,
  async (workspace) => {
    await assert.rejects(stat(path.join(workspace, "stable.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      stat(path.join(workspace, "absent-dir", "child.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(stat(path.join(workspace, ".git")), {
      code: "ENOENT",
    });
    await unlink(path.join(workspace, "hidden.txt"));
    await assert.rejects(stat(path.join(workspace, "hidden.txt")), {
      code: "ENOENT",
    });

    return done;
  },
  signal,
  false,
);
assert(
  stable.reads.some(
    (read) => read.path === "stable.json" && read.version === "missing",
  ),
);
assert(
  stable.reads.some(
    (read) => read.path === "absent-dir" && read.version === "missing",
  ),
);
assert(
  !stable.reads.some((read) =>
    [".git", "hidden.txt"].includes(read.path.toLowerCase()),
  ),
);
assert.equal(
  await readFile(path.join(source, "hidden.txt"), "utf8"),
  "lower survives private deletion",
);

await assert.rejects(
  validator.validate(
    source,
    input,
    async (workspace) => {
      await assert.rejects(stat(path.join(workspace, "new-dir", "file")), {
        code: "ENOENT",
      });
      await mkdir(path.join(source, "new-dir"));

      return done;
    },
    signal,
    false,
  ),
  { code: "FILE_TYPE_OR_LIMIT" },
);

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
          await assert.rejects(stat(path.join(workspace, "late.json")), {
            code: "ENOENT",
          });

          return done;
        },
        currentSignal ?? signal,
        false,
      );
      assert(
        receipt.reads.some(
          (read) => read.path === "late.json" && read.version === "missing",
        ),
      );
      await writeFile(
        path.join(source, "late.json"),
        "after validator stopped",
      );

      return receipt;
    },
  }),
  { code: "STALE_VALIDATION_DEPENDENCY" },
);

const manager = new OverlayManager(root, log);
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const control = path.join(root, "main-control");
try {
  await manager.start(id, source, control, workspace, true, signal, {
    kind: "local",
  });
  await assert.rejects(stat(path.join(workspace, "main-missing.json")), {
    code: "ENOENT",
  });
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
    batch.reads.some(
      (read) => read.path === "main-missing.json" && read.version === "missing",
    ),
  );
  await writeFile(path.join(source, "main-missing.json"), "after task stopped");
  await assert.rejects(
    publisher.publish(batch, { nativeWindows: true, validate: async () => {} }),
    { code: "STALE_DEPENDENCY" },
  );
} finally {
  await manager.close();
}

assert.equal(await readFile(path.join(source, "edit.txt"), "utf8"), "base");
assert(
  !(await readdir(candidateRoot)).some((name) => /^[a-f0-9-]{36}$/.test(name)),
);
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      checks: [
        "missing then present rejects candidate and edit",
        "later read preserves first absence",
        "stable absence and absent parent prefix exported",
        "policy hidden and whiteout are not lower absence",
        "new source directory rejected",
        "post-validation addition rejects publication",
        "native main batch absence rejects publication",
        "source edits preserved and candidates reclaimed",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`LOCAL_MISSING PASS root=${root}\n`);

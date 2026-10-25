/**
 * 手动验证 D170 发布 PoC 与现有 WinFsp 普通目录后端的最小衔接。
 * 1. 创建独占非 Git 来源，直接调用 OverlayManager Local 模式建立双视图，不经过 Riftri/WorktreeService。
 * 2. 默认保留旧的预声明基线对照；--native 改用原生自动基线和冻结导出，真实子进程编辑不变。
 * 3. 将明确选择的结果交给 Publisher；--native 在全新临时视图验证候选，保留原会话私有结果。
 * 4. 干净卸载/重挂载检查私有内容持久化，保存有界报告并保留实验现场。
 * --native 只发布明确选择的路径并校验其它原生读依赖；不宣称捕获所有 shell 副作用或自动 rebase。
 * 仅使用已安装 WinFsp/helper，不安装驱动、不创建分区、不接入产品 UI 或 Sandbox。
 * 所有子进程有期限；挂载管理和发布沿用统一日志/tracing；不属于默认 check 或 Evaluation。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";
import { durableJson, sourceIdentity } from "./local-overlay/files.js";
import { EditSession } from "./local-overlay/session.js";
import type { Batch } from "./local-overlay/session.js";
import { nativeBatch } from "./local-overlay/native-batch.js";
import { Publisher } from "./local-overlay/publisher.js";

const execute = promisify(execFile);
const native = process.argv.includes("--native");
const batches = new Map<string, Batch>();
assert.equal(process.platform, "win32", "Requires native Windows and WinFsp");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-winfsp-"));
const source = path.join(root, "source");
await mkdir(source);
const original =
  "const first = 1;\nconst second = 2;\nprocess.stdout.write(String(first + second));\n";
await writeFile(path.join(source, "module.mjs"), original);
await writeFile(path.join(source, "live.txt"), "initial\n");
const identity = await sourceIdentity(source);
const log = createLogger(root, "info");
let manager = new OverlayManager(root, log);
const views = [0, 1].map((index) => {
  const id = randomUUID();

  return {
    id,
    control: path.join(root, `control-${index}`),
    workspace: overlayWorkspace(overlayNamespace(root), id),
    session: new EditSession(identity),
  };
});

async function program(workspace: string) {
  const result = await execute(process.execPath, ["module.mjs"], {
    cwd: workspace,
    windowsHide: true,
    timeout: 10_000,
  });

  return result.stdout;
}

async function mount(create: boolean) {
  for (const view of views) {
    await manager.start(
      view.id,
      source,
      view.control,
      view.workspace,
      create,
      AbortSignal.timeout(30_000),
      { kind: "local" },
    );
  }
}

try {
  await mount(true);
  for (const view of views) {
    const metrics = await manager.metrics(view.id);
    assert.equal(metrics.lowerOpens, 0);
    assert.equal(metrics.lowerEnumerations, 0);
    assert.deepEqual(await readdir(path.join(view.control, "objects")), []);
    if (!native) {
      assert.equal(
        (await view.session.read("module.mjs"))?.toString(),
        original,
      );
    }

    assert.equal(
      await readFile(path.join(view.workspace, "module.mjs"), "utf8"),
      original,
    );
  }

  // In native mode these child operations alone establish their own baselines;
  // the caller has never captured B through EditSession or declared a write list.
  const editing = `
    import { readFile, writeFile, rename } from 'node:fs/promises';
    const text = await readFile('module.mjs', 'utf8');
    if (!text.includes(process.argv[1])) throw new Error('Unexpected fixture base');
    await writeFile('.module.tmp', text.replace(process.argv[1], process.argv[2]));
    await rename('.module.tmp', 'module.mjs');
    await writeFile('generated.txt', 'private generated artifact');
  `;
  const changes = [
    ["first = 1", "first = 10"],
    ["second = 2", "second = 20"],
  ];
  const children = await Promise.allSettled(
    views.map((view, index) =>
      execute(
        process.execPath,
        ["--input-type=module", "-e", editing, ...changes[index]!],
        {
          cwd: view.workspace,
          windowsHide: true,
          timeout: 10_000,
        },
      ),
    ),
  );
  for (const result of children) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  assert.deepEqual(
    await Promise.all(views.map((view) => program(view.workspace))),
    ["12", "21"],
  );
  assert.equal(
    await readFile(path.join(source, "module.mjs"), "utf8"),
    original,
  );
  assert.deepEqual((await readdir(source)).sort(), ["live.txt", "module.mjs"]);
  await writeFile(path.join(source, "live.txt"), "updated lower\n");
  for (const view of views) {
    assert.equal(
      await readFile(path.join(view.workspace, "live.txt"), "utf8"),
      "updated lower\n",
    );
    if (native) {
      const batch = await manager.withFrozen(view.id, (verifyReads) =>
        nativeBatch(identity, view.control, ["module.mjs"], verifyReads),
      );
      assert.equal(
        Buffer.from(batch.changes[0]!.base.content!, "base64").toString(),
        original,
      );
      batches.set(view.id, batch);
      await durableJson(path.join(root, `${view.id}.json`), batch);
    } else {
      await view.session.edit(
        "module.mjs",
        await readFile(path.join(view.workspace, "module.mjs")),
      );
      await view.session.save(path.join(root, `${view.id}.json`));
    }
  }

  if (native) {
    await manager.close();
    manager = new OverlayManager(root, log);
    await mount(false);
  }

  const publisher = new Publisher(path.join(root, "publisher"), log);
  const candidates: string[] = [];
  for (const view of views) {
    await publisher.publish(batches.get(view.id) ?? view.session.seal(), {
      nativeWindows: native,
      validate: async (files) => {
        const content = files.get("module.mjs");
        assert.ok(content);
        const validator = new OverlayManager(root, log);
        const validationId = randomUUID();
        const validationWorkspace = native
          ? overlayWorkspace(overlayNamespace(root), validationId)
          : view.workspace;
        try {
          if (native) {
            await validator.start(
              validationId,
              source,
              path.join(root, `validate-${validationId}`),
              validationWorkspace,
              true,
              AbortSignal.timeout(30_000),
              { kind: "local" },
            );
            await assert.rejects(
              readFile(path.join(validationWorkspace, "generated.txt")),
              { code: "ENOENT" },
            );
          }

          await writeFile(
            path.join(validationWorkspace, "module.mjs"),
            content,
          );
          await execute(process.execPath, ["--check", "module.mjs"], {
            cwd: validationWorkspace,
            windowsHide: true,
            timeout: 10_000,
          });
          candidates.push(await program(validationWorkspace));
        } finally {
          await validator.close();
        }
      },
    });
  }

  assert.deepEqual(candidates, ["12", "30"]);
  assert.equal(await program(source), "30");
  assert.deepEqual((await readdir(source)).sort(), ["live.txt", "module.mjs"]);
  await manager.close();
  manager = new OverlayManager(root, log);
  await mount(false);
  assert.deepEqual(
    await Promise.all(views.map((view) => program(view.workspace))),
    native ? ["12", "21"] : ["12", "30"],
  );
  for (const view of views) {
    assert.equal(
      await readFile(path.join(view.workspace, "generated.txt"), "utf8"),
      "private generated artifact",
    );
  }

  await manager.close();
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    backend:
      "native WinFsp Local live-directory overlay; Git metadata hidden and reserved",
    baselineCapture: native
      ? "automatic native capture and frozen export"
      : "explicit EditSession baseline",
    gitOperations: 0,
    riftriInvocations: 0,
    mounts: 2,
    initialPrivateContentObjects: 0,
    initialLowerEnumerations: 0,
    initialLowerOpensExcludingRootIdentity: 0,
    privateProgramResults: ["12", "21"],
    mergedCandidateResults: candidates,
    validationView: native
      ? "fresh overlay; original private results retained"
      : "same private view",
    sourceProgramResult: "30",
    liveLowerReads: "passed",
    unselectedArtifactsPublished: false,
    cleanRemount: "passed; private contents retained, no automatic rebase",
    cleanup: "clean helper exits confirmed",
    limitations: [
      native
        ? "Selected module.mjs only; bounded native read dependencies; no epoch reset or publication acknowledgement"
        : "Explicit module.mjs baseline only; no native changeset export or arbitrary shell dependency capture",
      "Host Node processes; no Sandbox validation in this experiment",
      "No large-repository or cold-cache benchmark",
      native
        ? "Native owner/group/DACL replacement; no SACL or external-writer CAS guarantee"
        : "Publisher still has phase-one ACL and external-writer race limitations",
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_OVERLAY_WINFSP PASS report=${path.join(root, "report.json")}\n`,
  );
} finally {
  await manager.close();
}

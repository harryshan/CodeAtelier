/**
 * 手动验证 Local overlay 发布确认和跨轮继续编辑，使用真实 WinFsp/NTFS 与宿主子进程。
 * 1. 两个无 Git 视图独立修改，冻结后自动导出、验证新候选、发布并确认；重挂载读取合并来源。
 * 2. 下一轮修改使用新代次，未选择产物仍保留原文及旧读依赖，不能借刷新洗掉过期依赖。
 * 3. 模拟确认已提交但宿主收据丢失；来源保持 complete，重试仅确认，不能删除下一轮私有编辑。
 * 4. 验证普通新建/删除覆盖释放及历史对象保留，输出摘要，不触碰真实项目、服务或驱动安装态。
 * 本脚本不属于默认 check/Evaluation；异常退出脏卷恢复、产品 UI/Runtime 生命周期另行验收。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { executeProcess } from "../src/tools/process.js";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  type OverlayAcknowledgement,
} from "../src/local-overlays/winfsp-manager.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-refresh-"));
const source = path.join(root, "source");
await mkdir(source);
const original =
  "const a = 1;\nconst b = 2;\nprocess.stdout.write(String(a + b));\n";
await writeFile(path.join(source, "module.mjs"), original);
await writeFile(path.join(source, "gone.txt"), "remove this");
const identity = await sourceIdentity(source);
const log = createLogger(root, "info");
const publisher = new Publisher(path.join(root, "publisher"), log);
const managers: OverlayManager[] = [];
const expectedRefusals = new Set<OverlayManager>();
const views = [0, 1].map((index) => {
  const id = randomUUID();

  return {
    id,
    control: path.join(root, `control-${index}`),
    workspace: overlayWorkspace(overlayNamespace(root), id),
    manager: new OverlayManager(root, log),
  };
});

async function mount(view: (typeof views)[number], create: boolean) {
  view.manager = new OverlayManager(root, log);
  managers.push(view.manager);
  await view.manager.start(
    view.id,
    source,
    view.control,
    view.workspace,
    create,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
}

async function command(
  workspace: string,
  args: string[],
  signal = AbortSignal.timeout(10_000),
) {
  const result = await executeProcess(
    process.execPath,
    args,
    workspace,
    signal,
    10_000,
    8192,
    () => {},
  );
  assert.equal(result.exitCode, 0);

  return result.output;
}

async function program(workspace: string, signal?: AbortSignal) {
  return command(workspace, ["module.mjs"], signal);
}

async function edit(
  view: (typeof views)[number],
  before: string,
  after: string,
) {
  const file = path.join(view.workspace, "module.mjs");
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(before));
  await writeFile(file, text.replace(before, after));
}

async function validate(
  files: ReadonlyMap<string, Buffer | null>,
  signal = AbortSignal.timeout(30_000),
) {
  const id = randomUUID();
  const workspace = overlayWorkspace(overlayNamespace(root), id);
  const manager = new OverlayManager(root, log);
  managers.push(manager);
  try {
    await manager.start(
      id,
      source,
      path.join(root, `validator-${id}`),
      workspace,
      true,
      signal,
      { kind: "local" },
    );
    for (const [file, content] of files) {
      signal.throwIfAborted();
      if (content === null) {
        await unlink(path.join(workspace, file));
      } else {
        await writeFile(path.join(workspace, file), content);
      }
    }

    await command(workspace, ["--check", "module.mjs"], signal);
    await program(workspace, signal);
    await assert.rejects(readFile(path.join(workspace, "artifact.txt")), {
      code: "ENOENT",
    });
  } finally {
    await manager.close();
  }
}

let lostRequest: OverlayAcknowledgement | undefined;

async function staleConfirmation() {
  const id = randomUUID();
  const view = {
    id,
    control: path.join(root, "stale-confirmation"),
    workspace: overlayWorkspace(overlayNamespace(root), id),
    manager: new OverlayManager(root, log),
  };
  await mount(view, true);
  await edit(view, "a = 10000;", "a = 100000;");
  let request: OverlayAcknowledgement | undefined;
  await view.manager.withFrozen(id, async (verify, _acknowledge, signal) => {
    const batch = await nativeBatch(
      identity,
      view.control,
      ["module.mjs"],
      verify,
    );
    request = batch.acknowledgement;
    const result = await publisher.publish(batch, {
      nativeWindows: true,
      signal,
      validate,
      refresh: {
        request,
        checkpoint: batch.checkpoint,
        acknowledge: async () => {
          throw new Error("Interrupted before acknowledgement");
        },
      },
    });
    assert.equal(result.refreshPending, true);
  });
  await mount(view, false);
  await edit(view, "a = 100000;", "a = 1000000;");
  await assert.rejects(
    view.manager.withFrozen(id, async (_verify, acknowledge) => {
      assert.ok(request);
      await acknowledge(request);
    }),
  );
  expectedRefusals.add(view.manager);
  const db = new DatabaseSync(path.join(view.control, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT object FROM sealed_changes WHERE path='\\MODULE.MJS'")
      .get();
    assert.ok(row && typeof row.object === "string");
    assert.ok(
      (
        await readFile(path.join(view.control, "objects", row.object), "utf8")
      ).includes("a = 1000000;"),
    );
    assert.equal(db.prepare("SELECT epoch FROM local_state").get()?.epoch, 0);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM acknowledgements").get()?.n,
      0,
    );
  } finally {
    db.close();
  }

  assert.equal(await program(source), "100020");
}

async function publish(
  view: (typeof views)[number],
  selected = ["module.mjs"],
  loseReceipt = false,
) {
  return view.manager.withFrozen(
    view.id,
    async (verify, acknowledge, signal) => {
      const batch = await nativeBatch(identity, view.control, selected, verify);
      const result = await publisher.publish(batch, {
        nativeWindows: true,
        signal,
        validate,
        refresh: {
          request: batch.acknowledgement,
          checkpoint: batch.checkpoint,
          acknowledge: async (request) => {
            await acknowledge(request);
            // Same lease replay is idempotent and does not advance a second epoch.
            await acknowledge(request);
            if (loseReceipt) {
              lostRequest = request;
              throw new Error("Simulated receipt loss after native commit");
            }
          },
        },
      });
      assert.equal(result.refreshPending, loseReceipt);
      assert.equal((await publisher.inspect(batch)).state, "complete");

      return result;
    },
  );
}

try {
  for (const view of views) {
    await mount(view, true);
    assert.equal((await view.manager.metrics(view.id)).lowerEnumerations, 0);
  }

  const first = views[0]!;
  const second = views[1]!;
  await edit(first, "a = 1", "a = 10");
  await edit(second, "b = 2", "b = 20");
  for (const view of views) {
    await writeFile(
      path.join(view.workspace, "artifact.txt"),
      "unselected private artifact",
    );
  }

  assert.deepEqual(
    await Promise.all(views.map((view) => program(view.workspace))),
    ["12", "21"],
  );
  await publish(first);
  await publish(second);
  assert.equal(await program(source), "30");
  for (const view of views) {
    await mount(view, false);
    assert.equal(await program(view.workspace), "30");
    assert.equal(
      await readFile(path.join(view.workspace, "artifact.txt"), "utf8"),
      "unselected private artifact",
    );
  }

  await edit(first, "a = 10;", "a = 100;");
  await publish(first);
  assert.equal(await program(source), "120");
  // Retained epoch-zero artifact still depends on the original module read.
  await assert.rejects(
    second.manager.withFrozen(second.id, (verify) =>
      nativeBatch(identity, second.control, ["artifact.txt"], verify),
    ),
    /STALE_DEPENDENCY/,
  );

  await mount(first, false);
  await edit(first, "a = 100;", "a = 1000;");
  const lost = await publish(first, ["module.mjs"], true);
  const journal = JSON.parse(
    await readFile(path.join(lost.directory, "journal.json"), "utf8"),
  );
  assert.equal(journal.state, "complete");
  assert.equal(journal.refresh.state, "pending");
  assert.equal(await program(source), "1020");
  await mount(first, false);
  await edit(first, "a = 1000;", "a = 10000;");
  await first.manager.withFrozen(first.id, async (_verify, acknowledge) => {
    assert.ok(lostRequest);
    await acknowledge(lostRequest);
  });
  await mount(first, false);
  assert.equal(await program(first.workspace), "10020");
  assert.equal(await program(source), "1020");
  await unlink(path.join(first.workspace, "gone.txt"));
  await writeFile(path.join(first.workspace, "new.txt"), "created source");
  await publish(first, ["module.mjs", "gone.txt", "new.txt"]);
  await writeFile(path.join(source, "gone.txt"), "external recreation");
  await mount(first, false);
  assert.equal(await program(first.workspace), "10020");
  assert.equal(
    await readFile(path.join(first.workspace, "gone.txt"), "utf8"),
    "external recreation",
  );
  assert.equal(
    await readFile(path.join(first.workspace, "new.txt"), "utf8"),
    "created source",
  );
  assert.equal(
    await readFile(path.join(first.workspace, "artifact.txt"), "utf8"),
    "unselected private artifact",
  );
  await writeFile(
    path.join(first.workspace, "artifact.txt"),
    "edited again privately",
  );
  await first.manager.withFrozen(first.id, async () => {});
  const db = new DatabaseSync(path.join(first.control, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(db.prepare("SELECT epoch FROM local_state").get()?.epoch, 4);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM acknowledgements").get()?.n,
      4,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM baselines").get()?.n, 1);
    assert.deepEqual(
      db
        .prepare(
          "SELECT epoch FROM change_epochs WHERE path='\\ARTIFACT.TXT' ORDER BY epoch",
        )
        .all()
        .map((row) => row.epoch),
      [0, 4],
    );
  } finally {
    db.close();
  }

  await staleConfirmation();

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    backend: "self-developed native WinFsp Local overlay v6",
    twoViewsAfterAcknowledgement: ["30", "30"],
    nextTurnSource: "120",
    retainedArtifact: "preserved; stale historical dependency rejected",
    acknowledgementReplay:
      "same frozen lease and later clean remount passed; later private edits preserved",
    lostReceipt: "source complete; view refresh pending; no source replay",
    staleUnappliedConfirmation:
      "rejected after new freeze; later private edit and source preserved",
    createDeleteRefresh:
      "passed; old whiteout released; external recreation visible",
    epochs: 4,
    limitations: [
      "Host verification only; production selection, task drain and Sandbox lifecycle not wired",
      "Historical objects and observations retained; no garbage collection",
      "Unexpected helper termination still blocks automatic restore",
      "No external-writer CAS, multi-file atomicity or complete shell dependency isolation",
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_OVERLAY_REFRESH PASS report=${path.join(root, "report.json")}\n`,
  );
} finally {
  const results = await Promise.allSettled(
    managers.map(async (manager) => {
      if (expectedRefusals.has(manager)) {
        await assert.rejects(manager.close());
      } else {
        await manager.close();
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
}

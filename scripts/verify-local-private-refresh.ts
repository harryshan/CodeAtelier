/**
 * 手动验证产品完成态私有刷新，使用真实 WinFsp、Publisher 和独占 NTFS 来源。
 * 1. 在确认前/确认后分别注入回执丢失，真实服务保存 failed 与 task/batch 排空资格。
 * 2. 重建 Service 后明确恢复；来源后续修改不重写，未选私有文件保留并能继续新任务。
 * 3. 每个场景只管理自己的挂载，正常退出写报告；失败保留现场，不安装/Repair 或重启用户服务。
 * 排空由可信宿主夹具声明，候选使用可信回调；不是 Sandbox、模型、真实崩溃或断电验收。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { createLogger } from "../src/logging/logger.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-private-refresh-"));
const log = createLogger(root, "info");
const results = [];
for (const afterAcknowledgement of [false, true]) {
  const caseRoot = path.join(root, afterAcknowledgement ? "after" : "before");
  const source = path.join(caseRoot, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "code.txt"), "original\n");
  const data = path.join(caseRoot, "data");
  let service = new LocalOverlayService(data, log);
  let lease: LocalOverlayLease | undefined;
  const originalPublish = Publisher.prototype.publish;
  const signal = AbortSignal.timeout(120_000);
  try {
    const id = randomUUID();
    const session = await service.create(
      { id, source },
      async (workspace) => ({ id: randomUUID(), workspace }) as Session,
    );
    const task = randomUUID();
    lease = await service.begin(session.workspace, session.id, task, signal);
    assert(lease);
    await writeFile(path.join(session.workspace, "code.txt"), "published\n");
    await writeFile(
      path.join(session.workspace, "private.txt"),
      "keep private\n",
    );
    await service.select(session.workspace, session.id, task, {
      paths: ["code.txt"],
      validate: async (files) => {
        assert.equal(files.get("code.txt")?.toString(), "published\n");
      },
    });
    Publisher.prototype.publish = async function (batch, options) {
      assert(options.refresh);
      const refresh = options.refresh;

      return originalPublish.call(this, batch, {
        ...options,
        refresh: {
          ...refresh,
          acknowledge: async (request) => {
            if (afterAcknowledgement) {
              await refresh.acknowledge(request);
            }

            throw new Error("injected lost refresh response");
          },
        },
      });
    };

    await assert.rejects(lease.finish("completed", true), {
      code: "VIEW_REFRESH_PENDING",
    });
    lease = undefined;
    Publisher.prototype.publish = originalPublish;
    assert(
      (await service.describe(session)).localOverlay?.privateRefreshRecovery,
    );
    assert.equal(
      await readFile(path.join(source, "code.txt"), "utf8"),
      "published\n",
    );
    await service.close();
    await writeFile(
      path.join(source, "code.txt"),
      "external after publication\n",
    );
    service = new LocalOverlayService(data, log);
    await service.recoverPrivateRefresh(session.workspace, session.id, signal);
    const info = (await service.describe(session)).localOverlay;
    assert.equal(info?.state, "ready");
    assert.equal(info.publication?.state, "published");
    assert.equal(info.privateRefreshRecovery, undefined);
    lease = await service.begin(
      session.workspace,
      session.id,
      randomUUID(),
      signal,
    );
    assert(lease);
    assert.equal(
      await readFile(path.join(session.workspace, "code.txt"), "utf8"),
      "external after publication\n",
    );
    assert.equal(
      await readFile(path.join(session.workspace, "private.txt"), "utf8"),
      "keep private\n",
    );
    await assert.rejects(readFile(path.join(source, "private.txt")), {
      code: "ENOENT",
    });
    await lease.finish("cancelled", true);
    lease = undefined;
    results.push({
      afterAcknowledgement,
      passed: true,
      freshSource: true,
      privateFileRetained: true,
      newTaskAllowed: true,
    });
  } finally {
    Publisher.prototype.publish = originalPublish;
    if (lease) {
      await lease.finish("cancelled", true).catch(() => {});
    }

    await service.close();
  }
}

const report = path.join(root, "report.json");
await writeFile(
  report,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      passed: true,
      results,
      limitations: [
        "Real clean WinFsp shutdown with injected lost acknowledgement, not a process crash",
        "Trusted host validation and drain declaration, not installed Sandbox or model",
        "No dirty-volume or stale recovery-guard reclamation",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`LOCAL_PRIVATE_REFRESH PASS ${report}\n`);

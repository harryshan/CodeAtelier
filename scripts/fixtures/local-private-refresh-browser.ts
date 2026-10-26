/**
 * 真实浏览器验收的完成态私有刷新场景，供 verify-local-overlay-browser --refresh 调用。
 * 1. 两个独立会话依次通过真实 UI/Sandbox 编辑并选择源码，分别在原生确认前后注入回执丢失。
 * 2. 生产 Engine 必须持久化排空资格；页面明确恢复，不重写来源、不自动运行任务，草稿仍保留。
 * 3. 新 Sandbox 任务验证最新来源和未选私有文件；finally 恢复仅此夹具的 Publisher 注入。
 * 不替换挂载、Runtime 或 HTTP；固定 provider 由调用方提供，故障注入不是进程崩溃或断电证明。
 */
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { Publisher } from "../../src/local-overlays/publication/publisher.js";
import type { Session, Snapshot, Task } from "../../src/shared/types.js";

export async function privateRefreshBrowser(input: {
  root: string;
  source: string;
  page: Page;
  create: () => Promise<Session>;
  snapshot: (session: Session) => Promise<Snapshot>;
  start: (page: Page, session: Session, prompt: string) => Promise<Task>;
  terminal: (
    session: Session,
    task: Task,
    expected: "completed" | "failed",
    expectedView?: "ready" | "failed",
  ) => Promise<Snapshot>;
  setPhase: (phase: "refresh-edit" | "refresh-check") => void;
}) {
  const { page, source } = input;
  const result: Session[] = [];
  for (const afterAcknowledgement of [false, true]) {
    const label = afterAcknowledgement ? "after" : "before";
    await writeFile(path.join(source, "refresh.txt"), "original");
    const session = await input.create();
    input.setPhase("refresh-edit");
    const originalPublish = Publisher.prototype.publish;
    let injected = 0;
    try {
      Publisher.prototype.publish = async function (batch, options) {
        assert.deepEqual(
          batch.changes.map((file) => file.path),
          ["refresh.txt"],
        );
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

              injected++;
              throw new Error("injected refresh receipt loss");
            },
          },
        });
      };

      const task = await input.start(
        page,
        session,
        `LOCAL refresh ${label}: edit and publish`,
      );
      const saved = await input.terminal(session, task, "failed", "failed");
      assert.equal(injected, 1);
      assert.equal(saved.session.localOverlay?.privateRefreshRecovery, true);
      assert.equal(
        saved.events.filter(
          (event) =>
            event.taskId === task.id &&
            event.type === "execution_instance" &&
            event.data.purpose === "local-validation" &&
            event.data.state === "completed",
        ).length,
        1,
      );
    } finally {
      Publisher.prototype.publish = originalPublish;
    }

    assert.equal(
      await readFile(path.join(source, "refresh.txt"), "utf8"),
      "published refresh",
    );
    await assert.rejects(
      readFile(path.join(source, "unselected-refresh.txt")),
      { code: "ENOENT" },
    );
    await writeFile(path.join(source, "refresh.txt"), "external after refresh");
    const before = await stat(path.join(source, "refresh.txt"), {
      bigint: true,
    });
    await page.getByLabel("任务描述").fill("keep this refresh draft");
    const [response] = await Promise.all([
      page.waitForResponse(
        (value) =>
          value.url().endsWith(`/api/sessions/${session.id}/local-refresh`) &&
          value.request().method() === "POST",
      ),
      page
        .getByRole("button", { name: "恢复已发布批次的私有视图", exact: true })
        .click(),
    ]);
    assert.equal(response.status(), 200);
    const recovered = (await response.json()) as Session;
    assert.equal(recovered.localOverlay?.state, "ready");
    assert.equal(recovered.localOverlay.publication?.state, "published");
    assert.equal(recovered.localOverlay.privateRefreshRecovery, undefined);
    assert.equal(
      recovered.localOverlay.refreshedTaskId,
      (await input.snapshot(session)).tasks[0]?.id,
    );
    assert.equal((await input.snapshot(session)).tasks.length, 1);
    await expect(page.getByLabel("任务描述")).toContainText(
      "keep this refresh draft",
    );
    await expect(page.getByText(/所选源码已发布/)).toBeVisible();
    await expect(
      page.getByText(
        "此前任务在收尾时失败；所选源码现已确认发布，私有视图已恢复。请从当前文件开始新任务。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "恢复任务", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: path.join(input.root, `refresh-${label}.png`),
      fullPage: true,
    });
    input.setPhase("refresh-check");
    const followup = await input.start(
      page,
      session,
      `LOCAL refresh ${label}: verify retained files`,
    );
    await input.terminal(session, followup, "completed");
    assert.equal((await input.snapshot(session)).tasks.length, 2);
    assert.equal(
      await readFile(path.join(source, "refresh.txt"), "utf8"),
      "external after refresh",
    );
    const after = await stat(path.join(source, "refresh.txt"), {
      bigint: true,
    });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    await assert.rejects(
      readFile(path.join(source, "unselected-refresh.txt")),
      { code: "ENOENT" },
    );
    result.push(recovered);
  }

  return result;
}

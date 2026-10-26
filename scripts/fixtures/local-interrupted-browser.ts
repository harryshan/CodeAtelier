/**
 * 真实浏览器验收的中断参考场景，供 verify-local-overlay-browser --interrupted 调用。
 * 1. 在已创建的独占 Local 视图中注入遗留 active 清单/锁，独立宿主真实恢复挂载并留下部分写入。
 * 2. UI 逐次验证 helper/owner 存活拒绝；仅终止本夹具进程，两者退出后检查/创建新参考会话。
 * 3. 通过调用方生产 HTTP/Sandbox 任务入口重新编辑发布，核对旧证据不变及无自动任务。
 * 4. finally 排空自己持有的进程；清单注入不等于真实服务/Runtime 崩溃，不删除旧卷或解除事故锁。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Session, Snapshot, Task } from "../../src/shared/types.js";

export async function interruptedBrowser(input: {
  root: string;
  data: string;
  source: string;
  parent: Session;
  page: Page;
  snapshot: (session: Session) => Promise<Snapshot>;
  start: (page: Page, session: Session, prompt: string) => Promise<Task>;
  terminal: (
    session: Session,
    task: Task,
    expected: "completed" | "failed",
  ) => Promise<Snapshot>;
}) {
  const { root, data, source, parent, page } = input;
  const id = parent.localOverlay!.id;
  const directory = path.join(data, "local-overlays");
  const control = path.join(directory, id);
  const manifest = path.join(directory, `${id}.json`);
  const lock = path.join(directory, `${id}.lock`);
  const record = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(record.phase, "ready");
  record.phase = "active";
  record.taskId = randomUUID();
  await writeFile(manifest, JSON.stringify(record));
  await writeFile(lock, "", { flag: "wx" });
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/fixtures/local-overlay-interrupted-owner.ts",
      root,
      control,
      parent.workspace,
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const ownerClosed = once(owner, "close");
  const signal = AbortSignal.timeout(180_000);
  let helper = 0;
  try {
    const [ready] = await once(owner, "message", { signal });
    assert.equal(ready.state, "ready");
    helper = ready.helper;
    assert(
      Number.isSafeInteger(helper) && helper > 0 && helper !== process.pid,
    );
    await page.reload();
    await page
      .getByRole("group", { name: source, exact: true })
      .getByRole("button", { name: parent.title, exact: true })
      .first()
      .click();
    await page.getByText("检查中断参考", { exact: true }).click();
    await page
      .getByLabel("相对文件路径")
      .fill("partial.txt\ngone.txt\nnew.txt");
    const inspect = async (status: number) => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (value) =>
            value.url().endsWith(`/api/sessions/${parent.id}/local-review`) &&
            value.request().method() === "POST",
        ),
        page.getByRole("button", { name: "查看中断内容", exact: true }).click(),
      ]);
      assert.equal(response.status(), status);
      assert.equal(response.request().postDataJSON().state, "interrupted");

      return response;
    };

    await inspect(409);
    const stopped = once(owner, "message", { signal });
    owner.send("crash-helper");
    assert.equal((await stopped)[0].state, "helper-exited");
    helper = 0;
    await inspect(409);
    owner.kill();
    await ownerClosed;
    const preserved = [
      manifest,
      lock,
      path.join(control, "overlay.sqlite"),
      path.join(control, "overlay.sqlite-wal"),
      path.join(control, "mount.lock"),
    ];
    const readPreserved = () =>
      Promise.all(
        preserved.map(async (file) =>
          readFile(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              return null;
            }

            throw error;
          }),
        ),
      );
    const before = await readPreserved();
    const reviewed = await inspect(200);
    assert.equal((await reviewed.json()).state, "interrupted");
    const results = page.getByRole("region", { name: "文件检查结果" });
    await results.locator("summary").filter({ hasText: "partial.txt" }).click();
    await expect(results).toContainText("private prefix only");
    await expect(results).toContainText("可能包含部分写入");
    await expect(results.getByRole("region", { name: "合并预览" })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: path.join(root, "interrupted-review.png"),
      fullPage: true,
    });
    await writeFile(path.join(source, "partial.txt"), "current source");
    const [continued] = await Promise.all([
      page.waitForResponse(
        (value) =>
          value.url().endsWith(`/api/sessions/${parent.id}/local-resolution`) &&
          value.request().method() === "POST",
      ),
      page.getByRole("button", { name: "在新对话中解决", exact: true }).click(),
    ]);
    assert.equal(continued.status(), 200);
    const child = (await continued.json()) as Session;
    assert.equal(child.localOverlay?.resolution?.state, "interrupted");
    assert.equal((await input.snapshot(child)).tasks.length, 0);
    await expect(page.getByLabel("任务描述")).toContainText(
      "不要重放原任务的未知操作",
    );
    const task = await input.start(
      page,
      child,
      "LOCAL UI interrupted reference: verify and explicitly edit",
    );
    const saved = await input.terminal(child, task, "completed");
    assert.equal(saved.session.localOverlay?.publication?.state, "published");
    assert.equal(saved.session.localOverlay.publication.files, 1);
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
    assert.equal(
      await readFile(path.join(source, "partial.txt"), "utf8"),
      "resolved from current source",
    );
    assert.deepEqual(await readPreserved(), before);
    assert.equal(
      (await input.snapshot(parent)).session.localOverlay?.state,
      "active",
    );
    assert.equal(
      await readFile(path.join(source, "gone.txt"), "utf8"),
      "original",
    );
    await assert.rejects(readFile(path.join(source, "new.txt")), {
      code: "ENOENT",
    });
    await expect(page.getByText(/所选源码已发布/)).toBeVisible();
    await page.screenshot({
      path: path.join(root, "interrupted-published.png"),
      fullPage: true,
    });

    return {
      child,
      parent,
      checks: [
        "active helper refused through HTTP",
        "active owner refused after helper exit",
        "partial material checked and continued through real UI",
        "new Runtime reads reference and latest lower",
        "explicit edit and local_publish pass candidate Runtime",
        "old manifest locks and SQLite bytes unchanged",
        "unselected interrupted additions and deletions not applied",
      ],
    };
  } finally {
    if (helper) {
      try {
        process.kill(helper);
      } catch {
        // Only the fixture helper tracked above can be terminated here.
      }
    }

    owner.kill();
    await ownerClosed;
  }
}

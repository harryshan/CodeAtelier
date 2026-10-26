/**
 * 隔离 Local 的浏览器契约验证，使用合成 HTTP/SSE，不挂载文件系统或运行 Sandbox。
 * 1. 固定创建 UUID 的错误/重试、模式参数、来源项目归组和刷新后私有状态展示。
 * 2. 后端能力拒绝阻止提交，合成已发布/拒绝/不可用状态不能被模型完成文本覆盖。
 * 3. 批量检查按文件展开纯文本 B/O/T 和预览，错误保留输入，改路径取消旧结果；不把模拟响应当真实发布证明。
 * 4. 显式创建冲突继续对话，失败保留固定请求重试，显示参考状态且仅预填任务，不自动提交。
 * 5. 来源事故检查/接受使用固定 token，未知结果重试；接受后原私有视图仍禁用，完成态和已记录决定分开提示。
 *    完成态只允许明确释放该批次来源锁，失败可重试；不提交任务或重新接受部分发布现场。
 * 页面和请求代码为生产实现；真实挂载/权限/发布链路另由手动 WinFsp 验证证明。
 */
import { expect, test } from "@playwright/test";
import type { Session } from "../../src/shared/types.js";

test("reviews a publication incident and accepts only that source decision without resuming the view", async ({
  page,
}) => {
  const failed: Session = {
    ...created,
    localOverlay: {
      ...created.localOverlay!,
      state: "failed",
      publicationRecovery: true,
    },
  };
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [failed] }),
  );
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session: failed, tasks: [], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  const token = "a".repeat(64);
  const accepts: unknown[] = [];
  let reviews = 0;
  await page.route(
    "**/api/sessions/local-overlay-ui/local-publication-review",
    async (route) => {
      reviews++;
      expect(route.request().postDataJSON()).toEqual({});
      const content = (text: string) => ({
        content: Buffer.from(text).toString("base64"),
        version: "v",
        mode: null,
      });
      await route.fulfill({
        json:
          reviews === 1
            ? {
                kind: "review",
                token,
                files: [
                  {
                    path: "code.txt",
                    recorded: "intent",
                    observed: "diverged",
                    before: content("old"),
                    proposed: content("candidate").content,
                    current: content("<script>unexpected()</script>"),
                  },
                ],
              }
            : reviews === 2
              ? { kind: "decision", token }
              : { kind: "complete", refresh: "pending" },
      });
    },
  );
  await page.route(
    "**/api/sessions/local-overlay-ui/local-publication-accept",
    async (route) => {
      accepts.push(route.request().postDataJSON());
      await route.fulfill(
        accepts.length === 1
          ? { status: 409, json: { error: "解锁结果未确认，可重试同一请求。" } }
          : { json: { kind: "accepted", alreadyAccepted: accepts.length > 2 } },
      );
    },
  );
  let taskStarted = false;
  let completedReleases = 0;
  await page.route(
    "**/api/sessions/local-overlay-ui/local-publication-release-complete",
    async (route) => {
      completedReleases++;
      expect(route.request().postDataJSON()).toEqual({});
      await route.fulfill(
        completedReleases === 1
          ? { status: 409, json: { error: "完成态解锁未确认" } }
          : { json: { kind: "complete-lock", released: true } },
      );
    },
  );
  await page.route("**/api/sessions/local-overlay-ui/tasks", async (route) => {
    taskStarted = true;
    await route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await page.getByText("核查来源发布事故", { exact: true }).click();
  expect(reviews).toBe(0);
  await page.getByRole("button", { name: "检查发布现场", exact: true }).click();
  await expect(
    page.getByText("code.txt：当前现场已变化", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "主目录当前内容" }),
  ).toHaveCount(0);
  await page.getByText("code.txt：当前现场已变化", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "主目录当前内容" }),
  ).toContainText("<script>unexpected()</script>");
  expect(accepts).toHaveLength(0);
  const accept = page.getByRole("button", {
    name: "接受当前现场并解除发布阻塞",
    exact: true,
  });
  await accept.click();
  await expect(page.getByRole("alert")).toContainText("未确认");
  await accept.click();
  expect(accepts).toEqual([{ token }, { token }]);
  await expect(page.getByText(/本次来源发布阻塞已处理/)).toBeVisible();
  await page.getByLabel("任务描述").fill("不得恢复事故视图");
  await expect(page.getByRole("button", { name: "开始执行" })).toBeDisabled();
  await page.getByRole("button", { name: "检查发布现场", exact: true }).click();
  await expect(page.getByText(/已记录接受当前现场的决定/)).toBeVisible();
  await page
    .getByRole("button", { name: "重试已记录的解锁", exact: true })
    .click();
  await expect(page.getByText(/本次来源发布阻塞已处理/)).toBeVisible();
  await page.screenshot({
    path: "test-results/local-overlay-incident.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "检查发布现场", exact: true }).click();
  await expect(page.getByText(/日志已记录来源发布完成/)).toContainText(
    "尚未确认",
  );
  await expect(accept).toHaveCount(0);
  expect(completedReleases).toBe(0);
  const releaseComplete = page.getByRole("button", {
    name: "解除已完成批次的来源阻塞",
    exact: true,
  });
  await releaseComplete.click();
  await expect(page.getByRole("alert")).toContainText("完成态解锁未确认");
  await releaseComplete.click();
  await expect(page.getByText(/本批次残留来源锁已解除/)).toContainText(
    "原私有视图仍保留",
  );
  await expect(page.getByRole("button", { name: "开始执行" })).toBeDisabled();
  await page.screenshot({
    path: "test-results/local-overlay-complete-lock.png",
    fullPage: true,
  });
  expect(completedReleases).toBe(2);
  expect(taskStarted).toBe(false);
});

const source = "/local-overlay-source";
const created: Session = {
  id: "local-overlay-ui",
  title: "私有并行对话",
  titleState: "completed",
  workspace: "/private/local-overlay-ui",
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  localOverlay: { id: "view", projectWorkspace: source, state: "ready" },
};

test("retries the same explicit Local request and keeps source grouping after reload", async ({
  page,
}) => {
  const requests: any[] = [];
  let sessions: Session[] = [];
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        localOverlayCreation: { enabled: true },
      },
    });
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "创建结果未确认，请重试同一请求。" },
        });
      } else {
        sessions = [created];
        await route.fulfill({ json: created });
      }
    } else {
      await route.fulfill({ json: sessions });
    }
  });
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session: created, tasks: [], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page.getByLabel("项目目录").fill(source);
  await page
    .getByRole("button", { name: "使用隔离 Local", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建隔离 Local 对话" });
  await expect(dialog.getByText(/无需 Git 仓库/)).toBeVisible();
  await page.screenshot({
    path: "test-results/local-overlay-create.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "创建隔离 Local", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("创建结果未确认");
  await dialog.getByRole("button", { name: "重试同一请求" }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual({
    workspace: source,
    localOverlay: { id: expect.any(String) },
  });
  await expect(page.getByText("隔离 Local", { exact: true })).toBeVisible();
  await expect(page.getByText(/尚无源码发布记录/)).toBeVisible();
  const project = page.getByRole("group", { name: source, exact: true });
  await expect(
    project.getByRole("button", { name: created.title, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/local-overlay-private.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await expect(
    page.getByText(created.workspace, { exact: true }),
  ).toBeVisible();
  await expect(
    project.getByRole("button", { name: "新建隔离 Local 对话", exact: true }),
  ).toBeVisible();
});

test("disables unsupported creation and distinguishes retained from published history", async ({
  page,
}) => {
  let session = structuredClone(created);
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        localOverlayCreation: {
          enabled: false,
          reason: "隔离 Local 当前需要启用 Sandbox。",
        },
      },
    });
  });
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { session, tasks: [], events: [], approvals: [] } }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建隔离 Local 对话", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建隔离 Local 对话" });
  await expect(dialog.getByText(/需要启用 Sandbox/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "创建隔离 Local", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  for (const state of [
    "selected",
    "published",
    "rejected",
    "retained",
  ] as const) {
    session = {
      ...created,
      localOverlay: {
        ...created.localOverlay!,
        publication: { state, files: 2 },
      },
    };
    await page.reload();
    await page
      .getByRole("button", { name: created.title, exact: true })
      .click();
    const expected = {
      selected: "已登记源码选择，尚未发布。",
      published: "所选源码已发布（2 个文件）",
      rejected: "来源冲突或验证未通过",
      retained: "本轮未发布，私有修改已保留。",
    }[state];
    await expect(page.getByText(expected, { exact: false })).toBeVisible();
  }

  session = { ...created, localOverlay: { id: "view", state: "unavailable" } };
  await page.reload();
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await expect(page.getByText(/私有视图需要核查/)).toBeVisible();
  await expect(page.getByText("检查私有修改", { exact: true })).toBeHidden();
  await page.getByLabel("任务描述").fill("不应执行");
  await expect(page.getByRole("button", { name: "开始执行" })).toBeDisabled();
});

test("reviews private contents as text and clears stale results on path edits", async ({
  page,
}) => {
  let sessions = [created];
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: sessions }),
  );
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session: created, tasks: [], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  const requests: string[][] = [];
  const continuations: any[] = [];
  const child: Session = {
    ...created,
    id: "resolution-ui",
    title: "解决冲突",
    workspace: "/private/resolution-ui",
    localOverlay: {
      id: "new-view",
      projectWorkspace: source,
      state: "ready",
      resolution: {
        sessionId: created.id,
        path: "merged.txt",
        paths: ["merged.txt", "second.txt"],
        directory: ".codeatelier-recovery-fixture",
      },
    },
  };
  await page.route(
    "**/api/sessions/local-overlay-ui/local-resolution",
    async (route) => {
      continuations.push(route.request().postDataJSON());
      if (continuations.length === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "创建结果未确认，请重试同一请求。" },
        });

        return;
      }

      sessions = [child, created];
      await route.fulfill({ json: child });
    },
  );
  await page.route(/\/api\/sessions\/resolution-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session: child, tasks: [], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/resolution-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  let submitted = false;
  await page.route("**/api/sessions/resolution-ui/tasks", async (route) => {
    submitted = true;
    await route.abort();
  });
  await page.route(
    "**/api/sessions/local-overlay-ui/local-review",
    async (route) => {
      const paths: string[] = route.request().postDataJSON().paths;
      requests.push(paths);
      if (paths.includes("missing.txt")) {
        await route.fulfill({
          status: 409,
          json: { error: "该路径没有封存私有修改。" },
        });

        return;
      }

      const content = (text: string) => ({
        content: Buffer.from(text).toString("base64"),
        version: "v",
        mode: null,
      });
      await route.fulfill({
        json: {
          version: "group-fixture",
          publicationChecked: false,
          files: paths.map((name) => ({
            path: name,
            epoch: 1,
            version: "fixture",
            publicationChecked: false,
            base: content("base"),
            ours: content("<img src=x onerror=alert(1)>"),
            current: content("external"),
            preview:
              name === "conflict.txt"
                ? { state: "conflict", reason: "TEXT_CONFLICT" }
                : {
                    state: "merged",
                    content: Buffer.from("candidate").toString("base64"),
                  },
          })),
        },
      });
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await page.getByText("检查私有修改", { exact: true }).click();
  const input = page.getByRole("textbox", { name: "相对文件路径" });
  const submit = page.getByRole("button", { name: "查看三方内容" });
  await input.fill("missing.txt");
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("没有封存");
  await expect(input).toHaveValue("missing.txt");
  await input.fill("conflict.txt");
  await submit.click();
  const result = page.getByRole("region", { name: "文件检查结果" });
  await expect(result).toContainText("内容存在冲突");
  await expect(
    result.getByRole("region", { name: "私有修改", exact: true }),
  ).toContainText("<img src=x onerror=alert(1)>");
  await expect(result.locator("img")).toHaveCount(0);
  await input.fill("merged.txt\nsecond.txt");
  await expect(result).toBeHidden();
  await submit.click();
  await expect(result).toContainText("尚未进行依赖检查和候选测试");
  await expect(result.getByRole("region", { name: "合并预览" })).toContainText(
    "candidate",
  );
  await expect(
    result.getByRole("region", { name: "私有修改", exact: true }),
  ).toHaveCount(1);
  await result.getByText("second.txt", { exact: true }).click();
  await expect(
    result.getByRole("region", { name: "私有修改", exact: true }),
  ).toHaveCount(2);
  await result.getByText("second.txt", { exact: true }).click();
  await expect(
    result.getByRole("region", { name: "私有修改", exact: true }),
  ).toHaveCount(1);
  expect(requests).toEqual([
    ["missing.txt"],
    ["conflict.txt"],
    ["merged.txt", "second.txt"],
  ]);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/local-overlay-review.png",
    fullPage: true,
  });
  await page.getByLabel("任务描述").fill("保留尚未发送的处理目标");
  await page
    .getByRole("button", { name: "在新对话中解决", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("创建结果未确认");
  await page
    .getByRole("button", { name: "重试同一创建请求", exact: true })
    .click();
  expect(continuations).toHaveLength(2);
  expect(continuations[0]).toEqual(continuations[1]);
  expect(continuations[0]).toMatchObject({
    paths: ["merged.txt", "second.txt"],
    version: "group-fixture",
  });
  await expect(page.getByText(/本对话从最新主目录开始/)).toBeVisible();
  await expect(page.getByText(/本对话从最新主目录开始/)).toContainText(
    "所选 2 个文件",
  );
  await expect(page.getByLabel("任务描述")).toHaveText(/重新检查当前源码/);
  await expect(page.getByLabel("任务描述")).toContainText(
    "保留尚未发送的处理目标",
  );
  await expect(
    page.getByRole("button", { name: created.title, exact: true }),
  ).toBeVisible();
  expect(submitted).toBe(false);
  await page.screenshot({
    path: "test-results/local-overlay-resolution.png",
    fullPage: true,
  });
});

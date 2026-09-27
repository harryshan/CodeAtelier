/**
 * 使用真实浏览器和测试服务验证会话 Sandbox 徽标在断线重连时的来源优先级。
 * 1. 路由提供隔离成功、尚无执行证据、执行结果未知及宿主回退的合成会话。
 * 2. bootstrap 保留测试服务的鉴权数据，只把初始状态模拟为 Windows 隔离待确认。
 * 3. SSE 响应结束触发浏览器重连；验证没有新增阶段时实际状态不被初始状态覆盖，切换会话不泄漏旧状态。
 * 不启动真实 Sandbox 或模型，不将模拟的阶段视为原生隔离验收。
 */

import { expect, test } from "@playwright/test";
import type {
  Event,
  SandboxStatus,
  Session,
  Snapshot,
} from "../../src/shared/types.js";

const createdAt = "2026-09-27T00:00:00.000Z";
const initialStatus: SandboxStatus = {
  enabled: true,
  requested: true,
  applied: false,
  mode: "unknown",
  platform: "win32",
  level: null,
  reason: "尚未验证当前 Runtime。",
};
const actualStatus: SandboxStatus = {
  enabled: true,
  requested: true,
  applied: true,
  mode: "sandboxed",
  platform: "win32",
  level: "windows-sandbox-user-agent-runtime",
};

function session(id: string, title: string): Session {
  return {
    id,
    title,
    titleState: "completed",
    workspace: "/sandbox-badge",
    createdAt,
    updatedAt: createdAt,
  };
}

test("keeps actual isolation across reconnects and clears it when switching sessions", async ({
  page,
}) => {
  const sessions = [
    session("isolated", "已执行对话"),
    session("pending", "未执行对话"),
    session("uncertain", "结果未知对话"),
    session("fallback", "宿主回退对话"),
  ];
  const statuses: Record<string, SandboxStatus> = {
    isolated: actualStatus,
    uncertain: {
      ...initialStatus,
      failureCategory: "runtime_execution",
      reason: "Sandbox 清理状态未知。",
    },
    fallback: {
      ...initialStatus,
      mode: "host-process-fallback",
      failureCategory: "runtime_self_check",
      reason: "Sandbox 自检失败，已自动改用宿主权限。",
    },
  };
  let bootstrapRequests = 0;
  let streamRequests = 0;

  await page.route("**/api/bootstrap", async (route) => {
    bootstrapRequests++;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, sandbox: initialStatus },
    });
  });
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: sessions }),
  );
  await page.route(
    /\/api\/sessions\/(isolated|pending|uncertain|fallback)(?:\?.*)?$/,
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      const after = Number(
        new URL(route.request().url()).searchParams.get("after") ?? 0,
      );
      const data: Snapshot = {
        session: sessions.find((item) => item.id === id)!,
        tasks: [],
        approvals: [],
        events:
          after === 0 && statuses[id]
            ? [
                {
                  id: 1,
                  sessionId: id,
                  taskId: "task",
                  type: "sandbox_stage",
                  data: { stage: "completed", ...statuses[id] },
                  createdAt,
                } satisfies Event,
              ]
            : [],
      };

      return route.fulfill({ json: data });
    },
  );
  await page.route(
    /\/api\/sessions\/(isolated|pending|uncertain|fallback)\/events$/,
    (route) => {
      streamRequests++;

      return route.fulfill({
        contentType: "text/event-stream",
        body: "event: refresh\ndata: {}\n\n",
      });
    },
  );

  await page.goto("/");
  await expect(page.getByLabel("Runtime 隔离状态：unknown")).toContainText(
    "隔离待确认",
  );
  await page.getByRole("button", { name: "已执行对话" }).click();
  const badge = page.locator('[class*="sandboxBadge"]');
  await expect(badge).toContainText("Runtime 已隔离");
  const beforeReconnect = bootstrapRequests;
  await expect.poll(() => bootstrapRequests).toBeGreaterThan(beforeReconnect);
  await expect.poll(() => streamRequests).toBeGreaterThan(1);
  await expect(badge).toContainText("Runtime 已隔离");

  await page.getByRole("button", { name: "未执行对话" }).click();
  await expect(badge).toContainText("隔离待确认");
  await page.getByRole("button", { name: "结果未知对话" }).click();
  await expect(badge).toContainText("隔离结果未知");
  await page.getByRole("button", { name: "宿主回退对话" }).click();
  await expect(badge).toContainText("Sandbox 失败：宿主运行");
  await page.getByRole("button", { name: "已执行对话" }).click();
  await expect(badge).toContainText("Runtime 已隔离");
});

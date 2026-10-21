/**
 * 验证无独立事件的任务提示和审批卡片仍归属于原任务，不滞留在会话末尾。
 * 1. history 构造多任务快照，包含多次中断、续聊和待审批，不访问服务或真实历史。
 * 2. 检查增量、刷新重建及旧页前插的位置一致，未加载旧任务不提前显示提示。
 * 3. 检查状态独立变化、无事件的最新任务及无锚点审批，保留提示和操作入口。
 */
import { expect, it } from "vitest";
import type { Snapshot } from "../src/shared/types.js";
import { SessionViewModel } from "../src/web/session-view.js";

function history(): Snapshot {
  const createdAt = "2026-10-21T00:00:00.000Z";

  return {
    session: {
      id: "s",
      title: "task controls",
      titleState: "completed",
      workspace: "/test",
      createdAt,
      updatedAt: createdAt,
    },
    tasks: ["first", "second", "latest"].map((id) => ({
      id,
      sessionId: "s",
      status: id === "latest" ? "waiting" : "interrupted",
      subagentsEnabled: false,
      createdAt,
    })),
    events: ["first", "second", "latest"].map((taskId, index) => ({
      id: index + 1,
      sessionId: "s",
      taskId,
      type: "user",
      data: { text: taskId },
      createdAt,
    })),
    approvals: ["first", "latest"].map((taskId) => ({
      id: taskId,
      sessionId: "s",
      taskId,
      tool: "run_command",
      description: taskId,
      repeatable: false,
    })),
  };
}

const keys = (view: ReturnType<SessionViewModel["update"]>) =>
  view.timeline.entries.map((entry) => entry.key);

it("anchors interrupted notices and approvals to their tasks across continuation and reload", () => {
  const data = history();
  const model = new SessionViewModel("s");
  const first = model.update({
    ...data,
    tasks: data.tasks.slice(0, 1),
    approvals: data.approvals.slice(0, 1),
    events: data.events.slice(0, 1),
  });
  const continued = model.update({ ...data, events: data.events.slice(1) });
  expect(keys(continued)).toEqual([
    "event:1",
    "approval:first",
    "interrupted:first",
    "event:2",
    "interrupted:second",
    "event:3",
    "approval:latest",
  ]);
  expect(keys(new SessionViewModel("s").update(data))).toEqual(keys(continued));
  expect(keys(first)).toEqual([
    "event:1",
    "approval:first",
    "interrupted:first",
  ]);

  const resolved = model.update({ ...data, events: [], approvals: [] });
  expect(keys(resolved)).toEqual(
    keys(continued).filter((key) => !key.startsWith("approval:")),
  );
});

it("does not show unloaded historical interruptions until their page is prepended", () => {
  const data = { ...history(), approvals: [] };
  const model = new SessionViewModel("s");
  const recent = model.update({ ...data, events: data.events.slice(2) });
  expect(keys(recent)).toEqual(["event:3"]);
  const older = model.prepend({ ...data, events: data.events.slice(0, 2) });
  expect(keys(older)).toEqual(keys(new SessionViewModel("s").update(data)));
  expect(keys(older)).toEqual([
    "event:1",
    "interrupted:first",
    "event:2",
    "interrupted:second",
    "event:3",
  ]);
});

it("keeps unanchored pending approvals and the latest empty interruption accessible", () => {
  const data = history();
  data.events = [];
  data.approvals = data.approvals.slice(1);
  data.tasks[2].status = "interrupted";
  const model = new SessionViewModel("s");
  expect(keys(model.update(data))).toEqual([
    "approval:latest",
    "interrupted:latest",
  ]);
  data.tasks = data.tasks.map((task) => ({ ...task, status: "completed" }));
  expect(keys(model.update({ ...data, approvals: [] }))).toEqual([]);
});

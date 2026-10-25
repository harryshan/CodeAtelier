/**
 * 同进程发布队列的并发回归，不模拟磁盘锁、WinFsp 或 Sandbox。
 * 1. 中间等待者取消后，后继仍须等待当前发布；不同来源可以立即执行。
 * 2. 当前发布抛错后队列继续，异常只传回原调用者，不自动重试其操作。
 * 持久锁残留和真正来源写入由 Publisher 及跨进程专项验证覆盖。
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { publicationTurn } from "../src/local-overlays/publication/queue.js";

it("cancelled waiters cannot let later publications overtake the current one", async () => {
  const key = randomUUID();
  const order: string[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = publicationTurn(key, undefined, async () => {
    order.push("first");
    ready();
    await barrier;
    order.push("first-finished");
  });
  await started;
  const controller = new AbortController();
  const cancelled = publicationTurn(key, controller.signal, async () => {
    order.push("cancelled-must-not-run");
  });
  const rejected = expect(cancelled).rejects.toThrow("cancelled");
  const last = publicationTurn(key, undefined, async () => {
    order.push("last");
  });
  controller.abort(new Error("cancelled"));
  await rejected;
  await publicationTurn(randomUUID(), undefined, async () => {
    order.push("other-source");
  });
  expect(order).toEqual(["first", "other-source"]);
  release();
  await Promise.all([first, last]);
  expect(order).toEqual(["first", "other-source", "first-finished", "last"]);
});

it("releases failed turns without replaying them", async () => {
  const key = randomUUID();
  let attempts = 0;
  await expect(
    publicationTurn(key, undefined, async () => {
      attempts++;
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(await publicationTurn(key, undefined, async () => "next")).toBe(
    "next",
  );
  expect(attempts).toBe(1);
});

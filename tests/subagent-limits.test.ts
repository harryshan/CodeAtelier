/*
 * 对全局 subagent Worker 租约调度进行纯行为回归，不启动实际 Worker 或模型。
 *
 * 1. 多任务争用时验证全局/单任务限制、释放后唤醒和 release 幂等。
 * 2. 排队中的取消只拒绝本任务请求，不撤回已运行线程的租约。
 *
 * 测试保证调度账本与实际线程生命周期区分；线程终止由调用方负责。
 */

import { expect, it } from "vitest";
import { SubagentLimits } from "../src/agent/subagent-limits.js";

it("shares bounded slots across tasks and releases them only once", async () => {
  const limits = new SubagentLimits(2, 1);
  const signal = new AbortController().signal;
  const first = await limits.acquire("a", signal);
  const second = await limits.acquire("b", signal);
  let acquired = false;
  const third = limits.acquire("c", signal).then((release) => {
    acquired = true;

    return release;
  });

  await Promise.resolve();
  expect(acquired).toBe(false);
  first();
  const release = await third;
  expect(acquired).toBe(true);
  first();
  second();
  release();
  const last = await limits.acquire("c", signal);
  last();
});

it("cancels waiting leases without granting them after an active lease exits", async () => {
  const limits = new SubagentLimits(1);
  const first = await limits.acquire("a", new AbortController().signal);
  const pending = limits.acquire("b", new AbortController().signal);
  limits.cancelTask("b");

  await expect(pending).rejects.toThrow("任务已取消");
  first();
  const last = await limits.acquire("c", new AbortController().signal);
  last();
});

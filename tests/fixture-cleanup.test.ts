/**
 * 直接验证公共 TestResources 的清理契约，不启动嵌套 Vitest 或故意超时的诊断进程。
 * 1. 用可控 Promise 和临时文件验证取消后等待在途操作、晚返回目录删除及关闭幂等。
 * 2. 注入资源关闭和路径错误，确认汇总失败但仍清理独立资源与目录。
 * 3. helpers 提供临时目录和外层作用域；仅操作测试自己的文件，不连接模型或服务。
 */
import { expect, it } from "vitest";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { temp } from "./fixtures/helpers.js";
import {
  TestResources,
  currentTestResources,
} from "./fixtures/test-resources.js";

it("drains late operations before closing resources and deleting directories", async () => {
  const parent = currentTestResources();
  const scope = new TestResources();
  parent.defer(() => scope.close());
  const root = await temp();
  const lateDirectory = path.join(root, "late");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const closeResource = scope.defer(() => {
    events.push("resource");
  });
  const operation = scope.track(async () => {
    await gate;
    await mkdir(lateDirectory);
    scope.directory(lateDirectory);
    await writeFile(path.join(lateDirectory, "result"), "done");
    events.push("operation");
  });

  const closing = scope.close();
  expect(scope.close()).toBe(closing);
  try {
    await Promise.resolve();
    expect(scope.signal.aborted).toBe(true);
    expect(events).toEqual([]);
    expect(() => scope.track(async () => {})).toThrow();
  } finally {
    release();
  }

  await operation;
  await closing;
  await closeResource();

  expect(events).toEqual(["operation", "resource"]);
  await expect(access(lateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("aggregates cleanup failures without skipping independent resources or directories", async () => {
  const scope = new TestResources();
  const root = await temp();
  const directory = path.join(root, "remaining");
  await mkdir(directory);
  const events: string[] = [];
  scope.defer(() => {
    events.push("remaining resource");
  });
  const failure = new Error("resource close failed");
  scope.defer(() => {
    throw failure;
  });
  scope.directory(path.join(root, "\u0000"));
  scope.directory(directory);

  const result = await scope.close().catch((error: AggregateError) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toHaveLength(2);
  expect((result as AggregateError).errors[0]).toBe(failure);
  expect(events).toEqual(["remaining resource"]);
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

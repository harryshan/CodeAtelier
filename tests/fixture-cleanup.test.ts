/**
 * 从独立 Vitest 进程验证超时后的夹具清理，避免预期超时把默认套件染红。
 * 1. 通过项目隔离启动器运行固定诊断配置，仍使用生产 ToolRunner 和真实命令。
 * 2. 读取 JSON 报告，要求只有主动超时失败；后继测试必须确认操作结束且目录消失。
 * 3. 子夹具负责资源善后；外层执行也登记取消/进程树等待，时限包含冷启动，不放宽被测 200ms 超时。
 * 4. 直接作用域用例验证晚返回目录、取消后排空、重复关闭，以及一项失败仍清理独立资源。
 */
import { expect, it } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { temp } from "./fixtures/helpers.js";
import {
  TestResources,
  currentTestResources,
} from "./fixtures/test-resources.js";
import { executeProcess } from "../src/tools/process.js";

it("cleans up timed-out test resources before the next test runs", async () => {
  const report = path.join(await temp(), "cleanup-report.json");
  const scope = currentTestResources();
  const execution = await scope.track(() =>
    executeProcess(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/test-runner.ts",
        "unit",
        "--config",
        "tests/fixtures/cleanup-vitest.config.ts",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      process.cwd(),
      scope.signal,
      45_000,
      1024 * 1024,
      () => {},
    ),
  );
  expect(execution.exitCode).toBe(1);

  const result = JSON.parse(await readFile(report, "utf8"));
  const cases = result.testResults.flatMap(
    (file: { assertionResults: any[] }) => file.assertionResults,
  );
  expect(cases).toHaveLength(6);
  const failures = cases.filter((entry: any) => entry.status === "failed");
  expect(failures).toHaveLength(3);
  for (const failure of failures) {
    expect(failure.title).toContain("intentionally times out");
    expect(failure.failureMessages).toHaveLength(1);
    // 子夹具的后继测试核对 task.result 中真实的超时原因，而非 reporter 的占位 stack。
  }

  expect(cases.filter((entry: any) => entry.status === "passed")).toHaveLength(
    3,
  );
  expect(JSON.stringify(result)).not.toContain("EBUSY");
}, 60_000);

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

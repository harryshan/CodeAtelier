/**
 * 文件作用：验证诊断日志的级别、脱敏、轮转和故障隔离。
 *
 * 使用场景与输入输出：
 * 使用真实 createLogger 和临时日志目录，结合 stdout/stderr 替身及文件操作验证可观察输出。
 *
 * 代码结构与阅读顺序：
 * 1. afterEach 恢复测试替身，首个用例覆盖级别过滤、关联字段和结构化凭据脱敏。
 * 2. 通过扩大已有日志触发轮转，核对当前文件和归档数量。
 * 3. 构造不可写日志目标，确认任务不会因日志故障崩溃且不会泄露原始载荷。
 * 4. 最后使用含引号凭据验证每条输出仍可作为 JSON 解析。
 *
 * 维护注意事项：
 * 需同时核对文件内容与失败降级行为，不把“不抛异常”当作完整日志正确性。
 */

import { it, expect, vi, afterEach } from "vitest";
import {
  readFile,
  writeFile,
  mkdir,
  truncate,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.restoreAllMocks());

it("filters levels, retains diagnostic context and redacts structured credentials", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const log = createLogger(root, "info", () => ["known-secret"]);

  log.debug({ event: "hidden" });
  log.info({
    event: "visible",
    taskId: "task-1",
    apiKey: "known-secret",
    token: "other-token",
    password: "other-password",
    detail: { token: "nested-token", password: 'quoted-"secret' },
  });
  const text = await readFile(path.join(root, "logs/app.log"), "utf8");

  expect(text).not.toContain("hidden");
  expect(text).not.toContain("known-secret");
  expect(text).not.toContain("other-token");
  expect(text).not.toContain("other-password");
  expect(text).not.toContain("nested-token");
  expect(text).not.toContain("quoted-");
  expect(JSON.parse(text)).toMatchObject({
    event: "visible",
    taskId: "task-1",
    level: 30,
  });
  log.level = "debug";
  log.debug({ event: "now-visible" });

  expect(await readFile(path.join(root, "logs/app.log"), "utf8")).toContain(
    "now-visible",
  );
});

it("rotates oversized logs and retains only four archives", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const folder = path.join(root, "logs");

  await mkdir(folder);
  const file = path.join(folder, "app.log");

  await writeFile(file, "current");
  await truncate(file, 10 * 1024 * 1024 + 1);
  for (let i = 1; i <= 4; i++) {
    await writeFile(file + "." + i, `archive${i}`);
  }

  createLogger(root, "info").info({ event: "new" });

  expect((await readdir(folder)).sort()).toEqual([
    "app.log",
    "app.log.1",
    "app.log.2",
    "app.log.3",
    "app.log.4",
  ]);
  expect(await readFile(file + ".4", "utf8")).toBe("archive3");
  expect(JSON.parse(await readFile(file, "utf8")).event).toBe("new");
});

it("log storage failure does not crash the task or expose the original payload", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const root = await temp();
  const log = createLogger(root, "info");

  await mkdir(path.join(root, "logs/app.log"));

  expect(() => log.error({ message: "sensitive-payload" })).not.toThrow();
  expect(errors).toHaveBeenCalledWith("CodeAtelier: log output unavailable\n");
});

it("keeps JSON logs valid when messages contain quoted credential assignments", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const secret = 'a"b\\c';
  const log = createLogger(root, "info", () => [secret]);

  log.info({
    event: "source",
    message: 'const options = { apiKey: "demo" };',
    secretText: secret,
    token: "credential",
  });
  const saved = JSON.parse(
    await readFile(path.join(root, "logs/app.log"), "utf8"),
  );

  expect(saved.event).toBe("source");
  expect(saved.secretText).toBe("[REDACTED]");
  expect(saved.token).toBe("[REDACTED]");
});

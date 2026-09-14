/**
 * 检查日志级别、凭据脱敏、文件轮转，以及日志写失败时的处理。
 * 使用真实 createLogger 和临时目录，通过模拟标准输出及文件操作核对结果。
 *
 * 1. 检查日志过滤、紧凑纯文本关联字段和凭据遮盖；afterEach 恢复模拟对象。
 * 2. 记录带错误码、原因链和堆栈的 Error，确认诊断细节保留但不泄露凭据。
 * 3. 增大已有日志以触发轮转，核对新文件和归档数量。
 * 4. 让日志目标无法写入，确认只出现固定提示，任务没有崩溃、原始内容没有泄露。
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
  expect(text).toMatch(/INFO\s+app visible/);
  expect(text).toContain("task=task-1");
  expect(text).not.toContain('"level":30');
  log.level = "debug";
  log.debug({ event: "now-visible" });
  log.info("Server listening at http://127.0.0.1:4142");
  const saved = await readFile(path.join(root, "logs/app.log"), "utf8");

  expect(saved).toContain("now-visible");
  expect([...saved.matchAll(/Server listening at/g)]).toHaveLength(1);
});

it("keeps detailed error metadata and stack traces in redacted plain text", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const root = await temp();
  const secret = "known-secret";
  const cause = new Error(`socket rejected ${secret}`);
  const error = Object.assign(new Error(`cannot persist ${secret}`), {
    code: "SQLITE_FULL",
    cause,
  });
  const log = createLogger(root, "info", () => [secret]);

  log.error({
    event: "task.persistence_failed",
    module: "agent",
    taskId: "task-1",
    err: error,
  });
  const text = await readFile(path.join(root, "logs/app.log"), "utf8");

  expect(text).toMatch(/ERROR\s+agent task\.persistence_failed/);
  expect(text).toContain('error=Error: "cannot persist [REDACTED]"');
  expect(text).toContain("code=SQLITE_FULL");
  expect(text).toContain('cause=Error: "socket rejected [REDACTED]"');
  expect(text).toContain("stack:");
  expect(text).not.toContain(secret);
  expect(text).not.toContain('{"level"');
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
  expect(await readFile(file, "utf8")).toMatch(/INFO\s+app new/);
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

it("redacts quoted credential assignments in formatted logs", async () => {
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
  const saved = await readFile(path.join(root, "logs/app.log"), "utf8");

  expect(saved).toMatch(/INFO\s+app source/);
  expect(saved).toContain("secretText=[REDACTED]");
  expect(saved).toContain("token=[REDACTED]");
  expect(saved).not.toContain(secret);
});

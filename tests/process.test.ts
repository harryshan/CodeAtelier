/**
 * 用短时运行的 Node 子进程检查 executeProcess 的输出、错误和取消行为。
 *
 * 1. 启动不存在的程序，检查错误包含子进程实际报错及超时资源清理。
 * 2. 分两次输出一个 UTF-8 字符，检查解码完整、颜色控制符跨 chunk 清理、子进程颜色环境和模型密钥隔离。
 * 3. 创建返回回调先于 PID 回调，PID 在进程结束前提供真实正数，供 Sandbox 执行账本持久化。
 * 4. file-backed 模式以实例临时目录代替 libuv stdio pipe，仍回传输出、PID 与阶段并在结束后删去临时文件。
 * 5. 输出持久化抛错、输入管道提前关闭时返回错误并停止进程；收到输出后取消进程，确认以取消错误结束。
 *
 * 用例结束后恢复环境变量；程序和参数直接传给执行器，不经过 shell 拼接。
 */

import { it, expect, vi, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import {
  executeProcess,
  executeProcessFileBacked,
} from "../src/tools/process.js";
import { temp } from "./fixtures/helpers.js";

it("rejects output persistence failures after stopping the child", async () => {
  const failure = new Error("output persistence failed");
  await expect(
    executeProcess(
      process.execPath,
      ["-e", 'console.log("ready");setTimeout(() => process.exit(0), 300)'],
      await temp(),
      new AbortController().signal,
      5000,
      1000,
      () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});

it("handles a child closing stdin before the supplied input is consumed", async () => {
  await expect(
    executeProcess(
      process.execPath,
      ["-e", "process.exit(0)"],
      await temp(),
      new AbortController().signal,
      5000,
      1000,
      () => {},
      {},
      undefined,
      Buffer.alloc(4 * 1024 * 1024),
    ),
  ).rejects.toBeInstanceOf(Error);
});

afterEach(() => vi.unstubAllEnvs());

it("reports the actual missing-executable error and releases its timeout", async () => {
  try {
    await executeProcess(
      "codeatelier-nonexistent-executable",
      [],
      await temp(),
      new AbortController().signal,
      3000,
      1000,
      () => {},
    );
    throw new Error("expected the nonexistent executable to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^无法启动命令，请检查可执行文件或 shell 路径。实际错误：.+/,
    );
  }
});

it("preserves split UTF-8 output and does not inherit the model API key", async () => {
  vi.stubEnv("CODEATELIER_API_KEY", "do-not-inherit");
  const chunks: string[] = [];
  const script =
    'const b=Buffer.from("中文");process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));console.log(process.env.CODEATELIER_API_KEY === undefined ? "KEY_ABSENT" : "KEY_LEAKED")},20)';
  const result = await executeProcess(
    process.execPath,
    ["-e", script],
    await temp(),
    new AbortController().signal,
    5000,
    2000,
    (s) => chunks.push(s),
  );

  expect(result.output).toContain("中文KEY_ABSENT");
  expect(chunks.join("")).toBe(result.output);
  expect(result.exitCode).toBe(0);
});

it("reports the spawned process id before completion", async () => {
  const processIds: number[] = [];
  const stages: string[] = [];
  const result = await executeProcess(
    process.execPath,
    ["-e", "setTimeout(() => process.exit(0), 20)"],
    await temp(),
    new AbortController().signal,
    5000,
    1000,
    () => {},
    {},
    (pid) => {
      stages.push("pid");
      processIds.push(pid);
    },
    undefined,
    () => stages.push("spawn-returned"),
  );

  expect(result.exitCode).toBe(0);
  expect(stages).toEqual(["spawn-returned", "pid"]);
  expect(processIds).toHaveLength(1);
  expect(processIds[0]).toBeGreaterThan(0);
});

it("streams file-backed output and removes its private spool", async () => {
  const outputDirectory = await temp();
  const stages: string[] = [];
  const chunks: string[] = [];
  const result = await executeProcessFileBacked(
    process.execPath,
    ["-e", 'console.log("file-backed-ok")'],
    outputDirectory,
    new AbortController().signal,
    5000,
    1000,
    (text) => chunks.push(text),
    outputDirectory,
    {},
    () => stages.push("pid"),
    () => stages.push("spawn-returned"),
  );

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("file-backed-ok");
  expect(chunks.join("")).toBe(result.output);
  expect(stages).toEqual(["spawn-returned", "pid"]);
  expect(await readdir(outputDirectory)).toEqual([]);
});

it("cancels a file-backed command and removes its private spool", async () => {
  const outputDirectory = await temp();
  const controller = new AbortController();

  await expect(
    executeProcessFileBacked(
      process.execPath,
      ["-e", 'console.log("ready");setTimeout(() => {}, 30_000)'],
      outputDirectory,
      controller.signal,
      5_000,
      1_000,
      () => controller.abort(),
      outputDirectory,
    ),
  ).rejects.toThrow("任务已取消");

  expect(await readdir(outputDirectory)).toEqual([]);
});

it("stops a file-backed child when output persistence fails", async () => {
  const outputDirectory = await temp();
  const failure = new Error("output persistence failed");

  await expect(
    executeProcessFileBacked(
      process.execPath,
      ["-e", 'console.log("ready");setTimeout(() => {}, 30_000)'],
      outputDirectory,
      new AbortController().signal,
      5_000,
      1_000,
      () => {
        throw failure;
      },
      outputDirectory,
    ),
  ).rejects.toBe(failure);

  expect(await readdir(outputDirectory)).toEqual([]);
});

it("removes split terminal controls and sets no-color child environment", async () => {
  const script =
    'process.stdout.write("\\u001b[");setTimeout(()=>{process.stdout.write("31mRED\\u001b[0m\\u001b]0;title\\u0007");console.log(process.env.NO_COLOR + process.env.FORCE_COLOR + process.env.CLICOLOR + process.env.CLICOLOR_FORCE + process.env.TERM)},10)';
  const result = await executeProcess(
    process.execPath,
    ["-e", script],
    await temp(),
    new AbortController().signal,
    5000,
    2000,
    () => {},
  );

  expect(result.output).toContain("RED1000dumb");
  expect(result.output).not.toMatch(/[\u001b\u009b\u009d]/);
});

it("cancels a running process after receiving output", async () => {
  const controller = new AbortController();

  await expect(
    executeProcess(
      process.execPath,
      ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
      await temp(),
      controller.signal,
      10000,
      1000,
      () => controller.abort(),
    ),
  ).rejects.toThrow("取消");
});

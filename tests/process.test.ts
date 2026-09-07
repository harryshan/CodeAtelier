import { it, expect, vi, afterEach } from "vitest";
import { executeProcess } from "../src/tools/process.js";
import { temp } from "./fixtures/helpers.js";
afterEach(() => vi.unstubAllEnvs());
it("reports missing executable and releases its timeout", async () => {
  await expect(
    executeProcess(
      "codeatelier-nonexistent-executable",
      [],
      await temp(),
      new AbortController().signal,
      3000,
      1000,
      () => {},
    ),
  ).rejects.toThrow("无法启动");
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

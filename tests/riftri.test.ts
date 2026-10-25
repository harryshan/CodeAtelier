/**
 * 验证 Riftri v2 原生适配器，进程和文件探测使用模拟，不冒充真实 CoW 验证。
 * 1. 缺少 helper、跨卷、旧版本和不支持卷均拒绝；取消不会变成能力错误。
 * 2. snapshot 不携带 commit、不调用 Git checkout；严格校验收据并保留未知结果。
 * 3. 空目录仍属于 Riftri；普通 Git 模式由 WorktreeService 单独处理。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { createCheckout, selectCheckout } from "../src/worktrees/riftri.js";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, stat: mocks.stat }));
vi.mock("../src/tools/process.js", () => ({ executeProcess: mocks.process }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lstat.mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  mocks.stat.mockResolvedValue({ dev: 1 });
});

it("rejects unavailable helpers rather than losing dirty files through Git fallback", async () => {
  mocks.lstat.mockResolvedValue(undefined);
  await expect(
    selectCheckout("source", "root", new AbortController().signal, "missing"),
  ).rejects.toThrow("显式选择 Git worktree");
  expect(mocks.process).not.toHaveBeenCalled();
});

it("does not downgrade cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    selectCheckout("source", "root", controller.signal, "helper"),
  ).rejects.toThrow();
});

it.each([
  { output: '{"version":2,"backend":null}' },
  { output: '{"version":1,"backend":"riftri-reflink"}' },
  { output: "invalid receipt" },
])("rejects unsupported or stale probes: %j", async ({ output }) => {
  mocks.process.mockResolvedValue({ exitCode: 0, output, truncated: false });
  await expect(
    selectCheckout("source", "root", new AbortController().signal, "helper"),
  ).rejects.toThrow("不会自动回退");
});

it("selects native cloning only on a supported same-volume destination", async () => {
  mocks.process.mockResolvedValue({
    exitCode: 0,
    output: '{"version":2,"backend":"riftri-reflink"}',
    truncated: false,
  });
  expect(
    await selectCheckout(
      "source",
      "root",
      new AbortController().signal,
      "helper",
    ),
  ).toEqual({ backend: "riftri-reflink" });
  mocks.stat
    .mockResolvedValueOnce({ dev: 1 })
    .mockResolvedValueOnce({ dev: 2 });
  await expect(
    selectCheckout("source", "root", new AbortController().signal, "helper"),
  ).rejects.toThrow("同一文件系统");
});

it.each([0, 7])(
  "retains snapshot semantics even with %i regular files",
  async (count) => {
    mocks.process.mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({ version: 2, clonedFiles: count }),
      truncated: false,
    });
    expect(
      await createCheckout(
        "source",
        "destination",
        { backend: "riftri-reflink" },
        new AbortController().signal,
        "helper",
      ),
    ).toEqual({ backend: "riftri-reflink", clonedFiles: count });
    expect(mocks.process.mock.calls[0]?.[1]).toEqual([
      "snapshot",
      "source",
      "destination",
    ]);
  },
);

it.each([
  { exitCode: 1, output: "", truncated: false },
  { exitCode: 0, output: '{"version":1,"clonedFiles":7}', truncated: false },
  { exitCode: 0, output: '{"version":2,"clonedFiles":7}', truncated: true },
])("never repeats failed or unknown native writes: %j", async (result) => {
  mocks.process.mockResolvedValue(result);
  await expect(
    createCheckout(
      "source",
      "destination",
      { backend: "riftri-reflink" },
      new AbortController().signal,
      "helper",
    ),
  ).rejects.toThrow();
  expect(mocks.process).toHaveBeenCalledTimes(1);
});

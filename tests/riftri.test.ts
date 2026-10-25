/**
 * 验证可选 Riftri 适配器的后端选择和不可重放边界，不访问真实模型。
 * 1. 模拟进程收据与 Git 查询，测试未安装、不支持、协议损坏和取消时的 fallback 规则。
 * 2. 创建测试确认已开始的原生失败不再次创建普通 checkout，成功后准确保存后端与克隆计数。
 * 原生物理共享由手动 verify-riftri 与 WSL fiemap 验证，不以这些模拟用例替代。
 */

import { beforeEach, expect, it, vi } from "vitest";
import { createCheckout, selectCheckout } from "../src/worktrees/riftri.js";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  git: vi.fn(),
  add: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, stat: mocks.stat }));
vi.mock("../src/tools/process.js", () => ({ executeProcess: mocks.process }));
vi.mock("../src/worktrees/git.js", () => ({
  git: mocks.git,
  addWorktree: mocks.add,
  gitEnvironment: () => ({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lstat.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ dev: 1 });
  mocks.git.mockResolvedValue("");
  mocks.add.mockResolvedValue(undefined);
});

it("uses ordinary Git when the optional helper is absent", async () => {
  const selection = await selectCheckout(
    "source",
    "root",
    new AbortController().signal,
    "missing",
  );
  expect(selection).toEqual({
    backend: "git",
    fallbackReason: "helper-unavailable",
  });
  expect(mocks.process).not.toHaveBeenCalled();
});

it("does not downgrade cancellation into a successful fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    selectCheckout("source", "root", controller.signal, "missing"),
  ).rejects.toThrow();
});

it.each([
  { output: '{"version":1,"backend":null}', reason: "unsupported-volume" },
  { output: '{"version":99}', reason: "helper-unavailable" },
])(
  "falls back before mutation when capability probing is unavailable: %j",
  async ({ output, reason }) => {
    mocks.lstat.mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
    });
    mocks.process.mockResolvedValue({ exitCode: 0, output, truncated: false });
    expect(
      await selectCheckout(
        "source",
        "root",
        new AbortController().signal,
        "helper",
      ),
    ).toEqual({ backend: "git", fallbackReason: reason });
    expect(mocks.add).not.toHaveBeenCalled();
  },
);

it("selects native cloning only on a supported same-volume checkout", async () => {
  mocks.lstat.mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  mocks.process.mockResolvedValue({
    exitCode: 0,
    output: '{"version":1,"backend":"riftri-reflink"}',
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
  expect(
    await selectCheckout(
      "source",
      "root",
      new AbortController().signal,
      "helper",
    ),
  ).toEqual({ backend: "git", fallbackReason: "different-volume" });
  mocks.git.mockResolvedValue("core.sparsecheckout\ntrue\0");
  expect(
    await selectCheckout(
      "source",
      "root",
      new AbortController().signal,
      "helper",
    ),
  ).toEqual({ backend: "git", fallbackReason: "sparse-checkout" });
});

it("retains the native choice and count after a verified population", async () => {
  mocks.process.mockResolvedValue({
    exitCode: 0,
    output: '{"version":1,"clonedFiles":7}',
    truncated: false,
  });
  expect(
    await createCheckout(
      "source",
      "destination",
      "commit",
      { backend: "riftri-reflink" },
      new AbortController().signal,
      "helper",
    ),
  ).toEqual({ backend: "riftri-reflink", clonedFiles: 7 });
});

it.each([
  { exitCode: 1, output: "", truncated: false },
  { exitCode: 0, output: '{"version":2,"clonedFiles":7}', truncated: false },
  { exitCode: 0, output: '{"version":1,"clonedFiles":7}', truncated: true },
])(
  "never repeats checkout after a failed or unknown native population: %j",
  async (result) => {
    mocks.process.mockResolvedValue(result);
    await expect(
      createCheckout(
        "source",
        "destination",
        "commit",
        { backend: "riftri-reflink" },
        new AbortController().signal,
        "helper",
      ),
    ).rejects.toThrow();
    expect(mocks.add).toHaveBeenCalledTimes(1);
  },
);

it("reports Git when all files required ordinary checkout", async () => {
  mocks.process.mockResolvedValue({
    exitCode: 0,
    output: '{"version":1,"clonedFiles":0}',
    truncated: false,
  });
  expect(
    await createCheckout(
      "source",
      "destination",
      "commit",
      { backend: "riftri-reflink" },
      new AbortController().signal,
      "helper",
    ),
  ).toEqual({
    backend: "git",
    clonedFiles: 0,
    fallbackReason: "no-reusable-files",
  });
});

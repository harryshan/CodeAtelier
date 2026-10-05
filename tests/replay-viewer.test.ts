/**
 * 离线 Replay 阅读器的纯投影与文件生成回归，不连接服务、不运行模型或 Evaluation。
 * 1. 合成夹具覆盖完整/legacy、重试、唯一和歧义调用关联，以及缺失结果不冒充成功。
 * 2. 检查搜索覆盖原始大载荷与组合筛选，损坏结构/版本明确拒绝。
 * 3. 真实生成自包含 HTML 验证脚本边界转义、CSP 和 wx 不覆盖文件；临时目录由测试清理。
 * 浏览器实际交互与无网络行为另由 e2e/replay-viewer.spec.ts 验证。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createReplayHtml,
  writeReplayHtml,
} from "../src/replay-viewer/html.js";
import {
  filterEntries,
  parseReplayCase,
  projectReplay,
} from "../src/replay-viewer/projection.js";
import { viewerFixture } from "./fixtures/replay-viewer.js";

it("keeps retries separate, associates exact call IDs and preserves unknown outcomes", () => {
  const entries = projectReplay(parseReplayCase(viewerFixture()));
  expect(entries[0].toolKeys).toEqual(["tool-0", "tool-1"]);
  expect(entries[1]).toMatchObject({
    status: "error",
    subtitle: expect.stringContaining("attempt 2"),
  });
  expect(entries[2].status).toBe("unknown");
  expect(entries.find((entry) => entry.key === "tool-0")).toMatchObject({
    status: "recorded",
    modelKey: "model-0",
  });
  expect(entries.find((entry) => entry.key === "tool-1")?.status).toBe("error");
  expect(entries.find((entry) => entry.key === "tool-2")).toMatchObject({
    status: "unknown",
    modelKey: undefined,
  });
  expect(
    filterEntries(entries, "rounds", "", "").map((entry) => entry.key),
  ).toEqual(["model-0", "model-1", "model-2", "tool-2"]);
});

it("does not invent model history for legacy cases or guess ambiguous ownership", () => {
  const legacy = viewerFixture();
  delete legacy.capture;
  legacy.source = "legacy";
  const entries = projectReplay(parseReplayCase(legacy));
  expect(entries.filter((entry) => entry.kind === "model")).toHaveLength(0);
  expect(filterEntries(entries, "rounds", "", "")).toHaveLength(3);

  const ambiguous = viewerFixture();
  ambiguous.capture!.modelExchanges.push({
    ...ambiguous.capture!.modelExchanges[0],
    id: "duplicate",
  });
  expect(
    projectReplay(ambiguous)
      .filter((entry) => entry.kind === "tool")
      .every((entry) => !entry.modelKey),
  ).toBe(true);
});

it("searches complete raw payloads and combines kind/state filters", () => {
  const data = viewerFixture();
  data.tools[0].result = { text: `${"x".repeat(25000)}hidden-needle` };
  const entries = projectReplay(data);
  expect(
    filterEntries(entries, "tool", "", "HIDDEN-NEEDLE").map(
      (entry) => entry.key,
    ),
  ).toEqual(["tool-0"]);
  expect(
    filterEntries(entries, "tool", "error", "pnpm test").map(
      (entry) => entry.key,
    ),
  ).toEqual(["tool-1"]);
  expect(filterEntries(entries, "event", "", "示例审批")).toHaveLength(1);
  expect(filterEntries(entries, "model", "unknown", "")).toHaveLength(1);
});

it("keeps arbitrary results recorded, flags known failures, and rejects malformed files", () => {
  const data = viewerFixture();
  for (const result of [
    { files: [{ status: "failed" }] },
    { isError: true },
    { error: "denied" },
  ]) {
    data.tools[0].result = result;
    expect(
      projectReplay(data).find((entry) => entry.key === "tool-0")?.status,
    ).toBe("error");
  }

  data.tools[0].result = null;
  expect(
    projectReplay(data).find((entry) => entry.key === "tool-0")?.status,
  ).toBe("recorded");
  expect(() => parseReplayCase({ ...data, schemaVersion: 2 })).toThrow(
    "Replay Case v1",
  );
  expect(() => parseReplayCase({ ...data, tools: [null] })).toThrow("tools.0");
  expect(() => parseReplayCase(null)).toThrow();
  expect(
    parseReplayCase({ ...data, futureField: "retained" }).futureField,
  ).toBe("retained");
});

it("embeds hostile text without ending its JSON script and refuses file overwrites", async () => {
  const data = viewerFixture();
  const hostile =
    '</script><script>globalThis.injected = true</script><img src="https://example.invalid/leak">\u2028';
  data.session.title = hostile;
  const html = await createReplayHtml(data);
  expect(html).not.toContain(hostile);
  expect(html).toContain("connect-src 'none'");
  expect(html).toContain("script-src 'sha256-");
  const payload = html.match(
    /<script id="replay-data" type="application\/json">([\s\S]*?)<\/script>/,
  )![1];
  expect(JSON.parse(payload).session.title).toBe(hostile);

  const directory = await mkdtemp(path.join(tmpdir(), "ca-viewer-"));
  const output = path.join(directory, "viewer.html");
  try {
    await writeReplayHtml(output, data);
    const original = await readFile(output, "utf8");
    await expect(writeReplayHtml(output)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(output, "utf8")).toBe(original);
    await expect(createReplayHtml({ schemaVersion: 2 })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

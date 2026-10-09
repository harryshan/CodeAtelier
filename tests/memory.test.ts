/**
 * 覆盖项目记忆 Markdown 存储、关键词检索及模型维护操作的可观察核心行为。
 * 测试通过临时工作区和平台数据目录调用真实 ProjectMemoryService，不依赖真实模型、用户项目或网络。
 *
 * 1. 验证 create 会在数据目录建立按真实工作区哈希隔离的 Markdown，并可被关键词检索。
 * 2. 验证 archive 无需确认即可停止注入但保留可恢复记录，版本冲突不会覆盖新内容。
 * 3. 验证疑似凭据被拒绝且不会留下记忆文件，直接格式错误读取会安全降级为不可用。
 * 4. 验证目录仅含 ID/摘要，read 单独返回同项目、同版本有效条目且不写盘。
 */

import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { ProjectMemoryService } from "../src/memory/service.js";
import {
  MAX_MEMORY_BUNDLE_CHARS,
  MAX_MEMORY_BUNDLE_ENTRIES,
} from "../src/memory/types.js";
import { temp } from "./fixtures/helpers.js";

async function createFixture() {
  const workspace = await temp();
  const directory = await temp();
  const service = new ProjectMemoryService(directory, pino({ enabled: false }));
  const scope = { workspace, sessionId: "session-1", taskId: "task-1" };

  return { workspace, directory, service, scope };
}

function createMutation(
  expectedVersion: string | null,
  statement = "项目使用 pnpm 运行验证命令。",
) {
  return {
    expectedVersion,
    operations: [
      {
        action: "create" as const,
        kind: "constraint" as const,
        title: "使用 pnpm",
        statement,
        tags: ["pnpm", "验证"],
        importance: "high" as const,
        confidence: "confirmed" as const,
        expiresAt: null,
        source: {
          summary: "当前任务已检查 package.json。",
          eventId: "event-1",
          filePath: "package.json",
          fileHash: "a".repeat(64),
        },
        reason: "这是后续任务需要遵守的稳定项目约束。",
      },
    ],
  };
}

it("stores a project-isolated Markdown memory and retrieves matching active entries", async () => {
  const fixture = await createFixture();
  const created = await fixture.service.apply(
    fixture.scope,
    createMutation(null),
  );

  expect(created.version).toMatch(/^[a-f0-9]{64}$/);
  expect(created.operations).toHaveLength(1);
  const file = path.join(
    fixture.directory,
    "memories",
    `${created.projectKey}.md`,
  );
  const markdown = await readFile(file, "utf8");
  const bundle = await fixture.service.retrieve(
    fixture.workspace,
    "如何运行 pnpm 验证？",
  );

  expect(markdown).toContain("# 项目记忆");
  expect(markdown).toContain("使用 pnpm");
  expect(bundle).toMatchObject({
    available: true,
    bundle: {
      version: created.version,
      entries: [
        expect.objectContaining({
          id: created.operations[0].id,
          summary: "使用 pnpm",
        }),
      ],
    },
  });
  expect(bundle.bundle?.entries).toEqual([
    { id: created.operations[0].id, summary: "使用 pnpm" },
  ]);
  expect(bundle.bundle?.text).not.toContain("项目使用 pnpm 运行验证命令。");
  expect(bundle.bundle?.text).not.toContain("当前任务已检查 package.json。");
  expect(bundle.bundle?.text).toContain("read");
  await expect(
    readFile(path.join(fixture.workspace, "memories", "x.md")),
  ).rejects.toThrow();
});

it("reads complete memory on demand without writes or cross-project access", async () => {
  const fixture = await createFixture();
  const created = await fixture.service.apply(
    fixture.scope,
    createMutation(null),
  );
  const request = {
    expectedVersion: created.version,
    operations: [{ action: "read", id: created.operations[0].id }],
  };
  const file = path.join(
    fixture.directory,
    "memories",
    `${created.projectKey}.md`,
  );
  const before = await readFile(file, "utf8");
  const result = await fixture.service.apply(fixture.scope, request);

  expect(result).toMatchObject({
    projectKey: created.projectKey,
    version: created.version,
    operations: [
      {
        action: "read",
        id: created.operations[0].id,
        entry: {
          statement: "项目使用 pnpm 运行验证命令。",
          source: { summary: "当前任务已检查 package.json。" },
          status: "active",
        },
      },
    ],
  });
  expect(await readFile(file, "utf8")).toBe(before);
  await expect(
    fixture.service.apply(fixture.scope, {
      ...request,
      operations: [
        { action: "read", id: "00000000-0000-0000-0000-000000000000" },
      ],
    }),
  ).rejects.toThrow("不可读取");
  await expect(
    fixture.service.apply(
      { ...fixture.scope, workspace: await temp() },
      {
        ...request,
        expectedVersion: null,
      },
    ),
  ).rejects.toThrow("不可读取");
  await expect(
    fixture.service.apply(fixture.scope, {
      ...request,
      expectedVersion: "b".repeat(64),
    }),
  ).rejects.toThrow("已被其他操作更新");
  await expect(
    fixture.service.apply(fixture.scope, {
      ...request,
      operations: [
        ...request.operations,
        ...createMutation(created.version).operations,
      ],
    }),
  ).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
});

it("rejects reads of archived, expired, disabled or malformed memory", async () => {
  const fixture = await createFixture();
  const mutation = createMutation(null);
  const created = await fixture.service.apply(fixture.scope, mutation);
  const id = created.operations[0].id;
  const archived = await fixture.service.apply(fixture.scope, {
    expectedVersion: created.version,
    operations: [{ action: "archive", id, reason: "已失效" }],
  });
  const read = (version: string | null, entryId = id) =>
    fixture.service.apply(fixture.scope, {
      expectedVersion: version,
      operations: [{ action: "read", id: entryId }],
    });

  await expect(read(archived.version)).rejects.toThrow("不可读取");
  const expired = await fixture.service.apply(fixture.scope, {
    expectedVersion: archived.version,
    operations: [
      {
        ...mutation.operations[0],
        statement: "过期约束",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ],
  });
  await expect(read(expired.version, expired.operations[0].id)).rejects.toThrow(
    "不可读取",
  );

  const file = path.join(
    fixture.directory,
    "memories",
    `${created.projectKey}.md`,
  );
  const active = await fixture.service.apply(
    fixture.scope,
    createMutation(expired.version, "新的有效条目"),
  );
  await expect(
    read(active.version, active.operations[0].id),
  ).resolves.toMatchObject({
    operations: [{ action: "read", entry: { statement: "新的有效条目" } }],
  });
  const markdown = await readFile(file, "utf8");
  expect(markdown).toContain("enabled: true");
  await writeFile(file, markdown.replace("enabled: true", "enabled: false"));
  const disabled = await fixture.service.retrieve(fixture.workspace, "pnpm");
  expect(disabled.bundle?.entries).toEqual([]);
  await expect(
    read(disabled.bundle!.version, active.operations[0].id),
  ).rejects.toThrow("不可读取");
  await writeFile(file, "invalid memory");
  await expect(read(disabled.bundle!.version)).rejects.toThrow();
});

it("keeps ranking and bounded summaries without charging full bodies to the catalog", async () => {
  const fixture = await createFixture();
  const empty = await fixture.service.retrieve(fixture.workspace, "target");
  expect(empty.bundle?.version).toBeNull();
  expect(empty.bundle?.text).toContain("null");
  const template = createMutation(null).operations[0];
  const operations = Array.from({ length: 10 }, (_, index) => ({
    ...template,
    title: index === 9 ? "target" : `摘要 ${index}`,
    statement: `条目 ${index}：${"历史正文。".repeat(200)}`,
    importance: index === 0 ? "pinned" : "normal",
  }));
  const created = await fixture.service.apply(fixture.scope, {
    expectedVersion: null,
    operations,
  });
  const first = await fixture.service.retrieve(fixture.workspace, "target");
  const second = await fixture.service.retrieve(fixture.workspace, "target");

  expect(first).toEqual(second);
  expect(first.bundle?.entries).toHaveLength(MAX_MEMORY_BUNDLE_ENTRIES);
  expect(first.bundle?.entries.slice(0, 2)).toEqual([
    { id: created.operations[0].id, summary: "摘要 0" },
    { id: created.operations[9].id, summary: "target" },
  ]);
  expect(first.bundle!.text.length).toBeLessThanOrEqual(
    MAX_MEMORY_BUNDLE_CHARS,
  );
  expect(first.bundle?.text).not.toContain("历史正文");
  expect(first.bundle?.text).not.toContain(template.source.summary);
});

it("archives an entry without confirmation and rejects stale file versions", async () => {
  const fixture = await createFixture();
  const created = await fixture.service.apply(
    fixture.scope,
    createMutation(null),
  );
  const archived = await fixture.service.apply(fixture.scope, {
    expectedVersion: created.version,
    operations: [
      {
        action: "archive",
        id: created.operations[0].id,
        reason: "当前任务确认该约束已经被新配置取代。",
      },
    ],
  });
  const bundle = await fixture.service.retrieve(fixture.workspace, "pnpm");

  expect(archived.operations).toEqual([
    { action: "archive", id: created.operations[0].id },
  ]);
  expect(bundle.bundle?.entries).toEqual([]);
  await expect(
    fixture.service.apply(
      fixture.scope,
      createMutation(created.version, "过期版本不能覆盖新记忆。"),
    ),
  ).rejects.toThrow("已被其他操作更新");
});

it("rejects sensitive content and degrades malformed external Markdown safely", async () => {
  const fixture = await createFixture();

  await expect(
    fixture.service.apply(
      fixture.scope,
      createMutation(null, "请使用 API_KEY=super-secret-token-value。"),
    ),
  ).rejects.toThrow("不能保存疑似凭据");
  const missing = await fixture.service.retrieve(fixture.workspace, "API");
  expect(missing).toMatchObject({ available: true, bundle: { entries: [] } });

  const key = missing.bundle?.projectKey;
  const memoryDirectory = path.join(fixture.directory, "memories");
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(path.join(memoryDirectory, `${key}.md`), "not a memory file");
  const malformed = await fixture.service.retrieve(
    fixture.workspace,
    "anything",
  );

  expect(malformed).toMatchObject({
    available: false,
    bundle: null,
    errorCode: "memory_unavailable",
  });
});

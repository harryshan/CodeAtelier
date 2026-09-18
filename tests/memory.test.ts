/**
 * 覆盖项目记忆 Markdown 存储、关键词检索及模型维护操作的可观察核心行为。
 * 测试通过临时工作区和平台数据目录调用真实 ProjectMemoryService，不依赖真实模型、用户项目或网络。
 *
 * 1. 验证 create 会在数据目录建立按真实工作区哈希隔离的 Markdown，并可被关键词检索。
 * 2. 验证 archive 无需确认即可停止注入但保留可恢复记录，版本冲突不会覆盖新内容。
 * 3. 验证疑似凭据被拒绝且不会留下记忆文件，直接格式错误读取会安全降级为不可用。
 */

import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { ProjectMemoryService } from "../src/memory/service.js";
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
          title: "使用 pnpm",
        }),
      ],
    },
  });
  await expect(
    readFile(path.join(fixture.workspace, "memories", "x.md")),
  ).rejects.toThrow();
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

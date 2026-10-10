/**
 * 验证项目记忆 JSONL 快照、条目版本与原子写入的可观察行为。
 * 使用临时工作区中的真实 MemoryFileStore/ProjectMemoryService，不依赖模型、网络或个人记忆。
 *
 * 1. document 建立带有效来源的文档；JSONL 编解码用例覆盖文本往返、顺序、严格格式与重复 ID。
 * 2. jsonlFixture 写入真实 JSONL；读取必须无副作用，维护与重启保留条目和来源。
 * 3. 版本、并发、外部替换和提交失败用例保证不覆盖未知数据，不在坏 JSONL 上回退旧记忆。
 * 4. 所有文件由测试临时目录清理；错误只断言受控诊断，不要求泄露非法内容。
 */

import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { MemoryFileStore } from "../src/memory/file-store.js";
import { parseMemoryJsonl, serializeMemoryJsonl } from "../src/memory/jsonl.js";
import { ProjectMemoryService } from "../src/memory/service.js";
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_FILE_BYTES,
  type MemoryDocument,
} from "../src/memory/types.js";
import { temp } from "./fixtures/helpers.js";

function document(): MemoryDocument {
  return {
    schemaVersion: 1,
    projectKey: "a".repeat(64),
    workspace: "fixture",
    enabled: true,
    updatedAt: "2026-10-09T00:00:00.000Z",
    entries: [
      {
        id: randomUUID(),
        kind: "constraint",
        title: "测试约束",
        statement: "历史事实",
        tags: ["测试"],
        importance: "normal",
        status: "active",
        confidence: "observed",
        expiresAt: null,
        source: {
          sessionId: "session",
          taskId: "task",
          eventId: null,
          summary: "用户要求",
          filePath: null,
          fileHash: null,
        },
        lastReason: "保留稳定约束",
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
        lastUsedAt: null,
      },
    ],
  };
}

async function jsonlFixture() {
  const workspace = await temp();
  const directory = await temp();
  const store = new MemoryFileStore(directory);
  const empty = await store.load(workspace);
  const value = document();
  value.projectKey = empty.projectKey;
  value.workspace = await realpath(workspace);
  const folder = path.join(directory, "memories");
  const legacy = path.join(folder, `${empty.projectKey}.md`);
  const current = path.join(folder, `${empty.projectKey}.jsonl`);
  const text = serializeMemoryJsonl(value);
  await mkdir(folder);
  await writeFile(current, text);
  const service = new ProjectMemoryService(directory, pino({ enabled: false }));
  const scope = { workspace, sessionId: "session", taskId: "task" };

  return {
    workspace,
    directory,
    store,
    value,
    folder,
    legacy,
    current,
    text,
    service,
    scope,
  };
}

it("round-trips JSONL records with multiline Markdown text and stable mixed-kind order", () => {
  const value = document();
  value.entries[0].title = '标题 "引号" \\ 换行\n中文';
  value.entries[0].statement =
    "## 标题\n### 不应成为条目\n- status: archived\n\n正文\r\n末行\n";
  value.entries.push({
    ...value.entries[0],
    id: randomUUID(),
    kind: "decision",
  });
  value.entries.push({ ...value.entries[0], id: randomUUID() });
  const text = serializeMemoryJsonl(value);
  const lines = text.trimEnd().split("\n");

  expect(lines).toHaveLength(4);
  expect(JSON.parse(lines[0])).toMatchObject({
    type: "project",
    schemaVersion: 1,
  });
  expect(JSON.parse(lines[1])).toMatchObject({
    type: "memory",
    entry: value.entries[0],
  });
  expect(parseMemoryJsonl(text)).toEqual(value);
  expect(parseMemoryJsonl(text.replace(/\n/g, "\r\n"))).toEqual(value);
  expect(parseMemoryJsonl(text.slice(0, -1))).toEqual(value);
  expect(serializeMemoryJsonl(parseMemoryJsonl(text))).toBe(text);
  const empty = { ...value, entries: [] };
  expect(parseMemoryJsonl(serializeMemoryJsonl(empty))).toEqual(empty);
});

it("rejects bad records, duplicate IDs, oversized files and credentials without echoing content", () => {
  const value = document();
  const text = serializeMemoryJsonl(value);
  const [header, entry] = text.trimEnd().split("\n");
  const bad = [
    "",
    `\ufeff${text}`,
    `${header}\n\n${entry}\n`,
    `${header}\n{`,
    `${entry}\n${header}\n`,
    `${header}\n${header}\n`,
    `${text}${entry}\n`,
    text.replace('"schemaVersion":1', '"schemaVersion":999'),
    text.replace('"type":"memory"', '"type":"unknown"'),
    text.replace('"enabled":true', '"enabled":"true"'),
    text.replace('"enabled":true', '"enabled":true,"unknown":true'),
    `${header}\n${JSON.stringify({ type: "memory", entry: { ...value.entries[0], unexpected: true } })}\n`,
    `${header}\nnull\n`,
    `${header}\n[]\n`,
    " ".repeat(MAX_MEMORY_FILE_BYTES + 1),
  ];
  for (const input of bad) {
    expect(() => parseMemoryJsonl(input)).toThrow();
  }

  const duplicate = { ...value, entries: [value.entries[0], value.entries[0]] };
  expect(() => serializeMemoryJsonl(duplicate)).toThrow("重复");
  const oversized = {
    ...value,
    entries: Array.from({ length: MAX_MEMORY_ENTRIES + 1 }, () => ({
      ...value.entries[0],
      id: randomUUID(),
    })),
  };
  expect(() => serializeMemoryJsonl(oversized)).toThrow();
  const secret = "API_KEY=super-secret-token-value";
  value.entries[0].statement = secret;
  expect(() => serializeMemoryJsonl(value)).toThrow("不能保存疑似凭据");
  expect(() =>
    parseMemoryJsonl(
      `${header}\n${JSON.stringify({ type: "memory", entry: value.entries[0] })}\n`,
    ),
  ).toThrow("不能保存疑似凭据");
  expect(() => parseMemoryJsonl(`${header}\n{"${secret}`)).toThrow(
    "必须是完整 JSON 记录",
  );
});

it("reads JSONL without writing and persists maintenance across restarts", async () => {
  const fixture = await jsonlFixture();
  const bundle = await fixture.service.retrieve(fixture.workspace);
  const version = bundle.bundle!.entries[0].version;
  const result = await fixture.service.apply(fixture.scope, {
    operations: [
      {
        action: "read",
        id: fixture.value.entries[0].id,
        expectedVersion: version,
      },
    ],
  });

  expect(result.operations[0]).toMatchObject({
    entry: fixture.value.entries[0],
  });
  expect(await readdir(fixture.folder)).toEqual([
    path.basename(fixture.current),
  ]);
  expect(await readFile(fixture.current, "utf8")).toBe(fixture.text);
  const changed = await fixture.service.apply(fixture.scope, {
    operations: [
      {
        action: "archive",
        id: fixture.value.entries[0].id,
        expectedVersion: version,
        reason: "新决定替代",
      },
    ],
  });
  const persisted = parseMemoryJsonl(await readFile(fixture.current, "utf8"));
  expect(persisted.entries[0]).toMatchObject({
    ...fixture.value.entries[0],
    status: "archived",
    lastReason: "新决定替代",
    updatedAt: expect.any(String),
  });
  expect(changed.operations[0].version).not.toBe(version);
  expect(
    (await new MemoryFileStore(fixture.directory).load(fixture.workspace))
      .document,
  ).toEqual(persisted);
  expect(
    (await fixture.service.retrieve(fixture.workspace)).bundle?.entries,
  ).toEqual([]);
  await expect(
    fixture.service.apply(fixture.scope, {
      operations: [
        {
          action: "read",
          id: fixture.value.entries[0].id,
          expectedVersion: version,
        },
      ],
    }),
  ).rejects.toThrow("不可读取");
});

it("preserves JSONL on stale versions and failed changes and serializes concurrent updates", async () => {
  const fixture = await jsonlFixture();
  const bundle = (await fixture.service.retrieve(fixture.workspace)).bundle!;
  const target = bundle.entries[0];
  await expect(
    fixture.service.apply(fixture.scope, {
      operations: [
        {
          action: "archive",
          id: target.id,
          expectedVersion: "b".repeat(64),
          reason: "过期版本",
        },
      ],
    }),
  ).rejects.toThrow("已被其他操作更新");
  await expect(
    fixture.store.update(fixture.workspace, () => {
      throw new Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expect(await readdir(fixture.folder)).toEqual([
    path.basename(fixture.current),
  ]);
  const attempts = await Promise.allSettled(
    [
      fixture.service,
      new ProjectMemoryService(fixture.directory, pino({ enabled: false })),
    ].map((service) =>
      service.apply(fixture.scope, {
        operations: [
          {
            action: "archive",
            id: target.id,
            expectedVersion: target.version,
            reason: "并发归档",
          },
        ],
      }),
    ),
  );

  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    attempts.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  expect(
    parseMemoryJsonl(await readFile(fixture.current, "utf8")).entries[0],
  ).toMatchObject({
    ...fixture.value.entries[0],
    status: "archived",
    lastReason: "并发归档",
    updatedAt: expect.any(String),
  });
  expect(
    (await readdir(fixture.folder)).filter((file) => file.endsWith(".tmp")),
  ).toEqual([]);
});

it("rejects corrupt or wrong-project JSONL without loading leftover backups", async () => {
  const fixture = await jsonlFixture();
  await writeFile(fixture.legacy, "offline backup");
  await writeFile(fixture.current, "broken");
  expect(await fixture.service.retrieve(fixture.workspace)).toMatchObject({
    available: false,
  });
  await expect(
    fixture.store.update(fixture.workspace, (value) => ({
      document: value,
      result: null,
    })),
  ).rejects.toThrow();
  const other = { ...fixture.value, projectKey: "b".repeat(64) };
  await writeFile(fixture.current, serializeMemoryJsonl(other));
  await expect(fixture.store.load(fixture.workspace)).rejects.toThrow("不匹配");
  expect(await readFile(fixture.legacy, "utf8")).toBe("offline backup");
});

it("keeps JSONL authoritative and preserves its bytes on failed maintenance", async () => {
  const fixture = await jsonlFixture();
  const initial = serializeMemoryJsonl(fixture.value);
  await writeFile(fixture.current, initial);
  await writeFile(fixture.legacy, "broken old backup");
  const loaded = await fixture.store.load(fixture.workspace);
  expect(loaded.document).toEqual(fixture.value);
  expect(loaded.filePath).toBe(fixture.current);
  await expect(
    fixture.store.update(fixture.workspace, (value) => ({
      document: { ...value, entries: [value.entries[0], value.entries[0]] },
      result: null,
    })),
  ).rejects.toThrow("重复");
  expect(await readFile(fixture.current, "utf8")).toBe(initial);

  const external = serializeMemoryJsonl({ ...fixture.value, enabled: false });
  await expect(
    fixture.store.update(fixture.workspace, async (value) => {
      if (!value.enabled) {
        throw new Error("项目记忆已停用");
      }

      await writeFile(fixture.current, external);

      return { document: value, result: null };
    }),
  ).rejects.toThrow("已停用");
  expect(await readFile(fixture.current, "utf8")).toBe(external);
  expect(
    (await readdir(fixture.folder)).filter((file) => file.endsWith(".tmp")),
  ).toEqual([]);

  await writeFile(fixture.current, Buffer.from([0xff]));
  expect(await fixture.service.retrieve(fixture.workspace)).toMatchObject({
    available: false,
  });
});

it("preserves JSONL when escaped content would exceed the byte limit", async () => {
  const fixture = await jsonlFixture();

  const oversized = {
    ...fixture.value,
    entries: Array.from({ length: 100 }, () => ({
      ...fixture.value.entries[0],
      id: randomUUID(),
      statement: "\u0001".repeat(1000),
    })),
  };

  await expect(
    fixture.store.update(fixture.workspace, () => ({
      document: oversized,
      result: null,
    })),
  ).rejects.toThrow("512 KiB");
  expect(await readFile(fixture.current, "utf8")).toBe(fixture.text);
  expect(await readdir(fixture.folder)).toEqual([
    path.basename(fixture.current),
  ]);
});

it("rejects competing first creation and cleans temporary files after a failed publish", async () => {
  const fixture = await jsonlFixture();
  await rm(fixture.current);
  const attempts = await Promise.allSettled(
    [fixture.store, new MemoryFileStore(fixture.directory)].map((store) =>
      store.update(fixture.workspace, (value) => {
        if (value.entries.length) {
          throw new Error("条目已存在");
        }

        return { document: fixture.value, result: null };
      }),
    ),
  );
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    attempts.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  expect(await readFile(fixture.current, "utf8")).toBe(fixture.text);

  await rm(fixture.current);
  await expect(
    fixture.store.update(fixture.workspace, async () => {
      await mkdir(fixture.current);

      return { document: fixture.value, result: null };
    }),
  ).rejects.toThrow();
  expect(await readdir(fixture.current)).toEqual([]);
  expect(
    (await readdir(fixture.folder)).filter((file) => file.endsWith(".tmp")),
  ).toEqual([]);
});

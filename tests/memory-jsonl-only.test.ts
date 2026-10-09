/**
 * 验证项目记忆切换为 JSONL-only 后不会因残留 Markdown 重新出现旧记录。
 * 使用真实临时目录、FileStore 和 Service，不读取个人数据或启动模型。
 *
 * 1. legacyFixture 写入一条有效旧格式记录，用于发现意外保留的回退路径。
 * 2. 缺失 JSONL 时目录为空、read 拒绝旧 ID，首次维护只创建新的 JSONL。
 * 3. 删除 JSONL、损坏旧备份或只留下同名目录时，旧文件都不参与读取/版本判断。
 * 4. 临时文件由测试框架清理，旧字节必须始终保持不变。
 */

import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { MemoryFileStore } from "../src/memory/file-store.js";
import { parseMemoryJsonl } from "../src/memory/jsonl.js";
import { ProjectMemoryService } from "../src/memory/service.js";
import { temp } from "./fixtures/helpers.js";

async function legacyFixture() {
  const workspace = await temp();
  const directory = await temp();
  const store = new MemoryFileStore(directory);
  const empty = await store.load(workspace);
  const id = randomUUID();
  const folder = path.dirname(empty.filePath);
  const legacy = path.join(folder, `${empty.projectKey}.md`);
  const text = `---
schemaVersion: 1
projectKey: ${JSON.stringify(empty.projectKey)}
workspace: ${JSON.stringify(empty.document.workspace)}
enabled: true
updatedAt: "2026-10-09T00:00:00.000Z"
---

# 项目记忆

## constraint

### [${id}] Legacy only
- status: active
- importance: normal
- confidence: confirmed
- tags: []
- source: {"sessionId":"fixture","taskId":"fixture","eventId":null,"summary":"fixture","filePath":null,"fileHash":null}
- reason: "fixture"
- createdAt: "2026-10-09T00:00:00.000Z"
- updatedAt: "2026-10-09T00:00:00.000Z"
- lastUsedAt: null
- expiresAt: null

This historical record must not be loaded.
`;
  await mkdir(folder);
  await writeFile(legacy, text);
  const service = new ProjectMemoryService(directory, pino({ enabled: false }));

  return {
    workspace,
    directory,
    store,
    empty,
    id,
    folder,
    legacy,
    text,
    service,
  };
}

it("ignores valid Markdown for retrieval, read and new JSONL maintenance without resurrecting it", async () => {
  const fixture = await legacyFixture();
  const loaded = await fixture.store.load(fixture.workspace);
  expect(loaded.version).toBeNull();
  expect(loaded.document.entries).toEqual([]);
  expect(loaded.filePath).toBe(fixture.empty.filePath);
  expect(await fixture.service.retrieve(fixture.workspace)).toMatchObject({
    available: true,
    bundle: { version: null, entries: [] },
  });
  await expect(
    fixture.service.apply(
      { workspace: fixture.workspace, sessionId: "fixture", taskId: "fixture" },
      {
        expectedVersion: null,
        operations: [{ action: "read", id: fixture.id }],
      },
    ),
  ).rejects.toThrow("不可读取");
  expect(await readdir(fixture.folder)).toEqual([
    path.basename(fixture.legacy),
  ]);

  await fixture.store.update(fixture.workspace, null, (document) => ({
    document,
    result: null,
  }));
  expect(
    parseMemoryJsonl(await readFile(fixture.empty.filePath, "utf8")).entries,
  ).toEqual([]);
  expect(await readFile(fixture.legacy, "utf8")).toBe(fixture.text);

  await rm(fixture.empty.filePath);
  expect(
    (await new MemoryFileStore(fixture.directory).load(fixture.workspace))
      .document.entries,
  ).toEqual([]);
  expect(await readFile(fixture.legacy, "utf8")).toBe(fixture.text);
});

it("does not inspect malformed Markdown or a same-named directory when JSONL is missing", async () => {
  const fixture = await legacyFixture();
  await writeFile(fixture.legacy, "broken historical backup");
  expect(await fixture.service.retrieve(fixture.workspace)).toMatchObject({
    available: true,
    bundle: { version: null, entries: [] },
  });
  expect(await readFile(fixture.legacy, "utf8")).toBe(
    "broken historical backup",
  );

  await rm(fixture.legacy);
  await mkdir(fixture.legacy);
  expect((await fixture.store.load(fixture.workspace)).version).toBeNull();
  await expect(readFile(fixture.empty.filePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

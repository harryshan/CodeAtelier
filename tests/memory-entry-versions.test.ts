/**
 * 验证逐条版本的记忆读写隔离，使用真实 Service 和临时 JSONL，不访问用户记忆。
 * 1. fixture/create 建立两条独立记忆，并保留模拟运行中任务拿到的旧目录。
 * 2. 无关条目变化及 JSON 排版变化不影响 read/update/archive，返回版本属于对应条目。
 * 3. 同条目修改、删除、项目停用和混合批次冲突安全拒绝，失败不留下部分写入。
 * 4. 并发不同条目及 create 均保留；同一条旧版本最多一个提交成功。
 * 5. FileStore 测试故意在转换期间模拟外部写入，验证未发布重算、目标冲突/停用拒绝和持续竞争清理。
 *    这种竞态注入仅用于测试，生产转换函数不得包含外部副作用。
 */

import { expect, it } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { MemoryFileStore } from "../src/memory/file-store.js";
import { applyMemoryMutation } from "../src/memory/mutator.js";
import { ProjectMemoryService } from "../src/memory/service.js";
import { parseMemoryJsonl, serializeMemoryJsonl } from "../src/memory/jsonl.js";
import { temp } from "./fixtures/helpers.js";

function create(title: string) {
  return {
    action: "create",
    kind: "constraint",
    title,
    statement: `事实 ${title}`,
    tags: [],
    importance: "normal",
    confidence: "confirmed",
    expiresAt: null,
    source: {
      summary: "测试来源",
      eventId: null,
      filePath: null,
      fileHash: null,
    },
    reason: "保存约束",
  };
}

async function fixture() {
  const workspace = await temp();
  const directory = await temp();
  const service = new ProjectMemoryService(directory, pino({ enabled: false }));
  const scope = { workspace, sessionId: "session", taskId: "task" };
  const created = await service.apply(scope, {
    operations: [create("A"), create("B")],
  });
  const file = path.join(directory, "memories", `${created.projectKey}.jsonl`);
  const bundle = (await service.retrieve(workspace)).bundle!;
  const [a, b] = bundle.entries;

  return { service, scope, file, a, b, store: new MemoryFileStore(directory) };
}

it("keeps an in-flight task's unchanged entries readable and writable after another entry changes", async () => {
  const { service, scope, file, a, b } = await fixture();
  const changed = await service.apply(scope, {
    operations: [
      {
        ...create("B changed"),
        action: "update",
        id: b.id,
        expectedVersion: b.version,
      },
    ],
  });
  expect(changed.operations[0].version).not.toBe(b.version);
  const read = await service.apply(scope, {
    operations: [{ action: "read", id: a.id, expectedVersion: a.version }],
  });
  expect(read.operations[0]).toMatchObject({
    id: a.id,
    version: a.version,
    entry: { title: "A" },
  });
  const archived = await service.apply(scope, {
    operations: [
      {
        action: "archive",
        id: a.id,
        expectedVersion: a.version,
        reason: "独立归档",
      },
    ],
  });
  expect(archived.operations[0].version).not.toBe(a.version);
  const stored = parseMemoryJsonl(await readFile(file, "utf8"));
  expect(stored.entries.map((entry) => [entry.title, entry.status])).toEqual([
    ["A", "archived"],
    ["B changed", "active"],
  ]);
});

it("ignores JSON property order, line endings and unrelated metadata changes", async () => {
  const { service, scope, file, a } = await fixture();
  const document = parseMemoryJsonl(await readFile(file, "utf8"));
  document.updatedAt = "2000-01-01T00:00:00.000Z";
  document.entries.reverse();
  const records = serializeMemoryJsonl(document)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  records[2].entry = Object.fromEntries(
    Object.entries(records[2].entry).reverse(),
  );
  await writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join("\r\n"),
  );
  const result = await service.apply(scope, {
    operations: [{ action: "read", id: a.id, expectedVersion: a.version }],
  });
  expect(result.operations[0]).toMatchObject({ id: a.id, version: a.version });
});

it("rejects a changed or deleted target without partially committing other operations", async () => {
  const { service, scope, file, a, b } = await fixture();
  const document = parseMemoryJsonl(await readFile(file, "utf8"));
  document.entries[0].statement = "外部修改正文但未更新时间";
  await writeFile(file, serializeMemoryJsonl(document));
  const before = await readFile(file, "utf8");
  await expect(
    service.apply(scope, {
      operations: [{ action: "read", id: a.id, expectedVersion: a.version }],
    }),
  ).rejects.toThrow("已被其他操作更新");
  await expect(
    service.apply(scope, {
      operations: [
        create("C"),
        {
          action: "archive",
          id: b.id,
          expectedVersion: b.version,
          reason: "批次",
        },
        {
          action: "archive",
          id: a.id,
          expectedVersion: a.version,
          reason: "批次",
        },
      ],
    }),
  ).rejects.toThrow("已被其他操作更新");
  expect(await readFile(file, "utf8")).toBe(before);
  document.entries = document.entries.filter((entry) => entry.id !== a.id);
  await writeFile(file, serializeMemoryJsonl(document));
  await expect(
    service.apply(scope, {
      operations: [
        {
          ...create("restore"),
          action: "update",
          id: a.id,
          expectedVersion: a.version,
        },
      ],
    }),
  ).rejects.toThrow();
  expect(
    parseMemoryJsonl(await readFile(file, "utf8")).entries.map(
      (entry) => entry.id,
    ),
  ).toEqual([b.id]);
});

it("serializes independent updates and creates without global version conflicts", async () => {
  const { service, scope, file, a, b } = await fixture();
  await Promise.all([
    service.apply(scope, {
      operations: [
        {
          ...create("new A"),
          action: "update",
          id: a.id,
          expectedVersion: a.version,
        },
      ],
    }),
    service.apply(scope, {
      operations: [
        {
          ...create("new B"),
          action: "update",
          id: b.id,
          expectedVersion: b.version,
        },
      ],
    }),
    service.apply(scope, { operations: [create("C")] }),
    service.apply(scope, { operations: [create("D")] }),
  ]);
  expect(
    parseMemoryJsonl(await readFile(file, "utf8"))
      .entries.map((entry) => entry.title)
      .sort(),
  ).toEqual(["C", "D", "new A", "new B"]);
});

it("rejects concurrent stale updates to the same entry and duplicate IDs in one batch", async () => {
  const { service, scope, file, a } = await fixture();
  const attempts = await Promise.allSettled(
    ["first", "second"].map((title) =>
      service.apply(scope, {
        operations: [
          {
            ...create(title),
            action: "update",
            id: a.id,
            expectedVersion: a.version,
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
  const current = (await service.retrieve(scope.workspace)).bundle!.entries[0];
  const archive = {
    action: "archive",
    id: current.id,
    expectedVersion: current.version,
    reason: "归档",
  };
  const before = await readFile(file, "utf8");
  await expect(
    service.apply(scope, { operations: [archive, archive] }),
  ).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
});

it("rebases an unpublished mutation onto unrelated external changes without losing either entry", async () => {
  const { store, scope, file, a } = await fixture();
  const mutation = {
    operations: [
      {
        action: "archive" as const,
        id: a.id,
        expectedVersion: a.version,
        reason: "归档 A",
      },
    ],
  };
  let attempts = 0;

  const result = await store.update(scope.workspace, async (document) => {
    attempts += 1;
    const changed = applyMemoryMutation(document, mutation, scope);
    if (attempts === 1) {
      document.entries[1].statement = "提交期间外部更新 B";
      await writeFile(file, serializeMemoryJsonl(document));
    }

    return changed;
  });

  expect(attempts).toBe(2);
  const current = parseMemoryJsonl(await readFile(file, "utf8"));
  expect(current.entries[0].status).toBe("archived");
  expect(current.entries[1].statement).toBe("提交期间外部更新 B");
  expect(result.result).toEqual([
    {
      action: "archive",
      id: a.id,
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
});

it.each(["target", "disabled"] as const)(
  "rejects %s changes detected while preparing an unpublished batch",
  async (scenario) => {
    const { store, scope, file, a, b } = await fixture();
    const mutation = {
      operations: [a, b].map((entry) => ({
        action: "archive" as const,
        id: entry.id,
        expectedVersion: entry.version,
        reason: "整批归档",
      })),
    };
    let attempts = 0;
    let external = "";

    await expect(
      store.update(scope.workspace, async (document) => {
        attempts += 1;
        const changed = applyMemoryMutation(document, mutation, scope);
        if (scenario === "target") {
          document.entries[0].statement = "外部修改目标";
        } else {
          document.enabled = false;
        }

        external = serializeMemoryJsonl(document);
        await writeFile(file, external);

        return changed;
      }),
    ).rejects.toThrow(scenario === "target" ? "已被其他操作更新" : "已停用");

    expect(attempts).toBe(2);
    expect(await readFile(file, "utf8")).toBe(external);
    expect(
      parseMemoryJsonl(external).entries.every(
        (entry) => entry.status === "active",
      ),
    ).toBe(true);
    expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
  },
);

it("bounds unpublished rebases and leaves only the latest external snapshot after continuous contention", async () => {
  const { store, scope, file, a } = await fixture();
  const mutation = {
    operations: [
      {
        action: "archive" as const,
        id: a.id,
        expectedVersion: a.version,
        reason: "归档 A",
      },
    ],
  };
  let attempts = 0;
  let external = "";

  await expect(
    store.update(scope.workspace, async (document) => {
      attempts += 1;
      const changed = applyMemoryMutation(document, mutation, scope);
      document.entries[1].statement = `外部变更 ${attempts}`;
      external = serializeMemoryJsonl(document);
      await writeFile(file, external);

      return changed;
    }),
  ).rejects.toThrow("本次操作未提交");

  expect(attempts).toBe(4);
  expect(await readFile(file, "utf8")).toBe(external);
  expect(parseMemoryJsonl(external).entries[0].status).toBe("active");
  expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
});

it("keeps project disablement authoritative for reads and all mutations", async () => {
  const { service, scope, file, a } = await fixture();
  const document = parseMemoryJsonl(await readFile(file, "utf8"));
  document.enabled = false;
  await writeFile(file, serializeMemoryJsonl(document));
  const before = await readFile(file, "utf8");
  for (const operation of [
    create("C"),
    { action: "read", id: a.id, expectedVersion: a.version },
    { action: "archive", id: a.id, expectedVersion: a.version, reason: "归档" },
  ]) {
    await expect(
      service.apply(scope, { operations: [operation] }),
    ).rejects.toThrow();
  }

  expect(await readFile(file, "utf8")).toBe(before);
});

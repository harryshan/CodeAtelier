/**
 * 验证 Store 请求在发送前的字节背压及 Worker 连接生命周期，不读取用户数据。
 * 1. 超预算请求必须明确拒绝且未发送，后续合法请求仍能执行，不能把拒绝当成未知提交。
 * 2. 连续写入只建立一次连接；关闭等待池释放文件，随后可独占改名或重新打开。
 * 3. 循环引用预算不会无限遍历；数据库写入仍保持自身 JSON/事务失败语义。
 */
import { expect, it } from "vitest";
import { rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreWorkerQueue } from "../src/sessions/store-worker-queue.js";
import { transferBytes } from "../src/sessions/transfer-budget.js";
import { SCHEMA_SQL } from "../src/sessions/schema.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { temp } from "./fixtures/helpers.js";

it("rejects unsent payloads without poisoning the queue and releases reused connections", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  db.exec(
    "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt) VALUES('s','test','/test','same','same')",
  );
  db.close();
  const traces = new TraceRecorder();
  traces.startTask("t", "s");
  const queue = new StoreWorkerQueue(traces, { requests: 8, bytes: 4096 });
  const base = {
    operation: "write" as const,
    file,
    sessionId: "s",
    taskId: "t",
  };
  await expect(
    queue.request({
      ...base,
      writes: [{ kind: "context", values: ["s", ["x".repeat(5000)]] }],
    }),
  ).rejects.toThrow("尚未发送");
  await queue.request({
    ...base,
    writes: [{ kind: "context", values: ["s", ["one"]] }],
  });
  await queue.request({
    ...base,
    writes: [{ kind: "context", values: ["s", ["two"]] }],
  });
  expect(await queue.request({ ...base, operation: "context" })).toEqual([
    "one",
    "two",
  ]);
  await queue.close();
  const trace = traces.exportTask("t")!;
  expect(
    trace.traceEvents.filter(
      (event) => event.name === "store.worker.connect" && event.ph === "b",
    ),
  ).toHaveLength(1);
  await rename(file, path.join(root, "closed.sqlite"));
});

it("bounds cyclic metadata without serializing the body", () => {
  const cyclic: { value: string; self?: unknown } = { value: "中文" };
  cyclic.self = cyclic;
  expect(transferBytes(cyclic, 1024)).toBeGreaterThan(0);
  expect(() => transferBytes({ text: "x".repeat(5000) }, 100)).toThrow("预算");
});

it("terminates an overdue reader instead of pinning its transaction indefinitely", async () => {
  const entry = new URL(
    "data:text/javascript,import {parentPort} from 'node:worker_threads';parentPort.on('message',()=>{});",
  );
  const queue = new StoreWorkerQueue(undefined, undefined, entry, 50);
  await expect(
    queue.request({ operation: "context", file: "unused", sessionId: "s" }),
  ).rejects.toThrow("只读");
  await queue.close();
});

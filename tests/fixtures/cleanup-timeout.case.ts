/**
 * 由 fixture-cleanup.test.ts 启动的独立 Vitest 子进程夹具，不进入默认 .test.ts 收集。
 * 1. beforeEach 等待真实命令输出后才启动正文的短超时，排除 shell 冷启动干扰。
 * 2. 每组先故意超时，再检查公共清理已停止命令/Engine、关闭真实 SQLite Worker 并删除目录。
 *    Store/Engine 组的正文直到 afterAll 才解除等待，证明资源释放不依赖正文 finally。
 * 3. afterAll 仅善后本夹具资源，保证旧实现的红色回归也不会遗留无限运行的子进程。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Config } from "../../src/config/config.js";
import { TestStore, TestEngine } from "./managed-runtime.js";
import { fileFixture, temp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof fileFixture>>;
let operation: Promise<void>;
let settled = false;
let commandError: unknown;
let previousFailure: { aborted: boolean; messages: string[] } | undefined;

// JSON reporter 的 timeout stack 可能只有 STACK_TRACE_ERROR，占位堆栈不是错误原因。
// 在框架已记录失败的 hook 中保存结构化 message，后继检查必须核对真正的正文超时。
afterEach(({ task, signal }) => {
  if (task.name.startsWith("intentionally times out")) {
    previousFailure = {
      aborted: signal.aborted,
      messages: task.result?.errors?.map((error) => error.message) ?? [],
    };
  }
});

function expectIntentionalTimeout() {
  expect(previousFailure).toEqual({
    aborted: true,
    messages: [expect.stringContaining("Test timed out in 200ms")],
  });
}

describe("timeout with an active command", () => {
  beforeEach(async () => {
    fixture = await fileFixture();
    operation = fixture.runner
      .forCall("timeout-command")
      .execute("run_command", {
        command:
          "node -e \"console.log('cleanup-ready');setTimeout(()=>process.exit(0),20000)\"",
      })
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          commandError = error;
          settled = true;
        },
      );
    await expect.poll(() => fixture.approvals.list().length).toBe(1);
    fixture.approvals.decide(fixture.approvals.list()[0].id, "once");
    await expect
      .poll(
        () =>
          fixture.events.some(
            (event) =>
              event.type === "command_output" &&
              event.data.text.includes("cleanup-ready"),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  it("intentionally times out while the command is alive", async () => {
    await operation;
  }, 200);
});

it("releases the previous test resources before starting the next test", async () => {
  expectIntentionalTimeout();
  expect(settled).toBe(true);
  expect(commandError).toMatchObject({
    message: expect.stringContaining("取消"),
  });
  await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(fixture.config.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

describe.each(["store", "engine"])("timeout with %s resources", (kind) => {
  let root: string;
  let store: TestStore;
  let engine: TestEngine | undefined;
  let modelCancelled = false;
  let releaseBody!: () => void;
  const body = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });

  describe("timed-out owner", () => {
    beforeEach(async () => {
      root = await temp();
      const config = new Config(root);
      store = new TestStore(path.join(root, "history.sqlite"));
      const session = await store.createAsync(root, "cleanup");
      if (kind === "engine") {
        let modelReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          modelReady = resolve;
        });
        engine = new TestEngine(
          store,
          config,
          pino({ enabled: false }),
          () => ({
            async run(_input, _instructions, _tools, signal) {
              modelReady();

              return new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    modelCancelled = true;
                    reject(signal.reason);
                  },
                  { once: true },
                );
              });
            },
          }),
        );
        engine.start(session.id, "wait until cleanup");
        await ready;
      }
    });

    it("intentionally times out before body cleanup can run", async () => {
      await body;
    }, 200);
  });

  it("closes runtime resources and removes the previous test directory", async () => {
    expectIntentionalTimeout();
    expect(() => store.db.prepare("SELECT 1")).toThrow();
    if (kind === "engine") {
      expect(modelCancelled).toBe(true);
      expect(engine?.active).toBeUndefined();
    }

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  afterAll(async () => {
    releaseBody();
    await engine?.close();
    await store?.closeAsync();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });
});

afterAll(async () => {
  fixture?.controller.abort();
  await operation;
  await fixture?.runner.close();
  if (fixture) {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.config.directory, { recursive: true, force: true });
  }
});

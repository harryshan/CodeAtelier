/**
 * 手动验证 Linux 产品 MXC → Agent Runtime → Broker Engine/SQLite 全链路，不接默认测试或 Evaluation。
 * 1. 只允许 Linux 非 root，创建独立工作区、Broker 数据和假秘密；使用真实工厂与生产 Runtime bundle。
 * 2. 确定性模型请求读/写/命令，检查系统网络隔离、环境不继承及 Broker 文件不可读；四工作区并发。
 * 3. 命令取消检查普通与 detached 后代心跳停止，服务关闭保存 interrupted；重开 SQLite 后人工恢复和续聊。
 * 4. waitForIdle 用定时器轮询真实活动状态，避免等待并不存在的 Task.done 造成微任务饥饿。
 * 5. 每阶段实时输出并保存报告，清理前也保存快照；保留随机实验目录，不读取用户数据库、.env 或模型凭据。
 * 使用 node --import tsx 执行，因此生产 .ts 依赖及 Store Worker 仍走源码开发入口；Sandbox 使用固定 bundle。
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { Engine } from "../../src/agent/engine.ts";
import { Config } from "../../src/config/config.ts";
import { Store } from "../../src/sessions/store.ts";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
assert.ok(
  process.env.MXC_PRODUCT_REPORT,
  "provide MXC_PRODUCT_REPORT explicitly",
);
const root = await mkdtemp(
  path.join(
    path.dirname(path.resolve(process.env.MXC_PRODUCT_REPORT)),
    "product-case-",
  ),
);
const data = path.join(root, "broker");
await mkdir(data);
const secret = path.join(data, "fake-secret.txt");
await writeFile(secret, "not-a-real-secret");
const hostNetwork = await readlink("/proc/self/ns/net");
process.env.CODEATELIER_BASE_URL = "https://example.invalid/v1";
process.env.CODEATELIER_MODEL = "fixture-model";
process.env.CODEATELIER_API_KEY = "";
delete process.env.CODEATELIER_AUXILIARY_MODEL;
process.env.CODEATELIER_SANDBOX_ENABLED = "true";
process.env.MXC_FAKE_SECRET = "must-not-reach-runtime";
const config = new Config(data);
config.settings.maxConcurrentTasks = 4;
const db = path.join(data, "sessions.db");
const report = {
  node: process.version,
  platform: process.platform,
  release: os.release(),
  root,
  cases: [],
  events: [],
};
let store = new Store(db);
let providerMode = "tools";
let modelEntered = false;
const counts = [];
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const command = (script) => `node -e ${quote(script)}`;

function tool(name, id, args) {
  return {
    type: "function_call",
    call_id: id,
    name,
    arguments: JSON.stringify({
      execution: { id, dependsOn: [] },
      arguments: args,
    }),
  };
}

function provider() {
  const mode = providerMode;
  const count = { mode, calls: 0 };
  counts.push(count);

  return {
    async getCapabilities() {
      return {
        limits: { max_context_window_tokens: 128_000, max_output_tokens: 1024 },
      };
    },
    async run(input, _instructions, tools, signal, onDelta) {
      count.calls += 1;
      assert.ok(tools.some((entry) => entry.name === "run_with_permissions"));
      if (mode === "pending") {
        modelEntered = true;
        signal.throwIfAborted();

        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }

      const expectedCallId = mode === "resume" ? "resume-read" : "read";
      const hasResults = input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === expectedCallId,
      );
      if (!hasResults || mode === "recover" || mode === "command-cancel") {
        if (mode === "resume") {
          assert.match(JSON.stringify(input), /function_call_output/);

          return {
            text: "",
            output: [
              tool("read_file", "resume-read", {
                path: "created.txt",
                startLine: 1,
                endLine: 5,
              }),
            ],
          };
        }

        if (mode === "recover") {
          return { text: "recovered without replay", output: [] };
        }

        if (mode === "command-cancel") {
          const heartbeat = "require('fs').appendFileSync('heartbeat','x')";
          const worker = `${heartbeat};setInterval(()=>{${heartbeat}},50)`;
          const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'}).unref();${worker}`;

          return {
            text: "",
            output: [
              tool("run_command", "long-command", { command: command(script) }),
            ],
          };
        }

        const boundary = `const fs=require('fs');const a=require('assert/strict');a.equal(process.env.MXC_FAKE_SECRET,undefined);a.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(hostNetwork)});a.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));fs.writeFileSync('command.txt','command-ok');process.stdout.write('boundaries-ok');`;

        return {
          text: "",
          output: [
            tool("read_file", "read", {
              path: "source.txt",
              startLine: 1,
              endLine: 5,
            }),
            tool("edit_files", "edit", {
              files: [
                {
                  path: "created.txt",
                  create: true,
                  content: "created-by-runtime\n",
                },
              ],
            }),
            tool("run_command", "command", { command: command(boundary) }),
          ],
        };
      }

      if (mode === "tools") {
        assert.match(JSON.stringify(input), /boundaries-ok/);
        assert.match(JSON.stringify(input), /source-from-fixture/);
      }

      onDelta("product-stream-delta");

      return { text: "product-complete", output: [] };
    },
  };
}

function newEngine() {
  const instance = new Engine(
    store,
    config,
    pino({ enabled: false }),
    provider,
  );
  instance.events.on("event", (event) => {
    if (
      [
        "notice",
        "error",
        "execution_instance",
        "tool_result",
        "task_end",
      ].includes(event.type)
    ) {
      report.events.push(event);
    }
  });

  return instance;
}

let engine = newEngine();

async function workspace(name) {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, "source.txt"), "source-from-fixture\n");

  return store.create(directory, name);
}

async function until(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `timeout: ${label}`);
    await delay(50);
  }
}

async function waitForIdle(instance) {
  // activeTasks 是 Task[]，不是内部 ActiveTask[]，不能读取 entry.done。
  // until 的 delay 让 trace/SQLite 等异步收尾继续推进，且等待具有明确期限。
  await until(() => !instance.hasActiveTasks, "engine idle");
}

async function saveReport() {
  await writeFile(
    process.env.MXC_PRODUCT_REPORT,
    JSON.stringify({ ...report, counts }, null, 2),
  );
}

async function settled(task, expected) {
  await until(
    () => !["queued", "running"].includes(store.task(task.id)?.status),
    "task terminal",
  );
  await waitForIdle(engine);

  assert.equal(
    store.task(task.id)?.status,
    expected,
    JSON.stringify(store.task(task.id)),
  );
  await store.drain();
}

async function check(name, operation) {
  const start = performance.now();
  report.currentCase = name;
  process.stdout.write(`START ${name}\n`);
  await saveReport();
  try {
    await operation();
    report.cases.push({
      name,
      passed: true,
      durationMs: Math.round(performance.now() - start),
    });
    process.stdout.write(`PASS ${name}\n`);
    await saveReport();
  } catch (error) {
    report.cases.push({ name, passed: false, error: String(error) });
    process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
    await saveReport();
    throw error;
  }
}

let originalSession;
try {
  await check("idle wait yields to timer-driven finalization", async () => {
    const fixture = {
      hasActiveTasks: true,
      activeTasks: [{ id: "plain-task-without-done" }],
    };
    const timer = setTimeout(() => {
      fixture.hasActiveTasks = false;
    }, 10);
    try {
      await waitForIdle(fixture);
      assert.equal(fixture.hasActiveTasks, false);
    } finally {
      clearTimeout(timer);
    }
  });
  await check(
    "four product tasks: real factory, tools, namespace, SQLite and trace",
    async () => {
      const sessions = await Promise.all(
        Array.from({ length: 4 }, (_, i) => workspace(`workspace-${i}`)),
      );
      originalSession = sessions[0];
      const tasks = sessions.map((session) =>
        engine.start(session.id, "perform fixture tools"),
      );
      await Promise.all(tasks.map((task) => settled(task, "completed")));
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        assert.equal(
          await readFile(
            path.join(sessions[i].workspace, "created.txt"),
            "utf8",
          ),
          "created-by-runtime\n",
        );
        assert.equal(
          await readFile(
            path.join(sessions[i].workspace, "command.txt"),
            "utf8",
          ),
          "command-ok",
        );
        const events = store.taskEvents(task.id);
        assert.ok(
          events.some(
            (event) =>
              event.type === "delta" &&
              event.data.text === "product-stream-delta",
          ),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "execution_instance" &&
              event.data.mode === "linux-bubblewrap" &&
              event.data.state === "completed" &&
              event.data.pidKind === "runtime-launcher",
          ),
        );
        assert.ok(!events.some((event) => event.type === "sandbox_fallback"));
        const trace = JSON.parse(await engine.savedTrace(task));
        for (const name of [
          "sandbox.mxc.launch",
          "sandbox.mxc.cleanup",
          "read_file.worker.response",
        ]) {
          assert.ok(
            trace.traceEvents.some((event) => event.name === name),
            name,
          );
        }

        assert.equal(store.replayCase(task.id).capture.tools.length, 3);
      }

      assert.deepEqual(await readdir(path.join(data, "mxc", "active")), []);
    },
  );

  await check(
    "command cancellation stops ordinary and detached heartbeat",
    async () => {
      providerMode = "command-cancel";
      const session = await workspace("cancel-workspace");
      const task = engine.start(
        session.id,
        "start then cancel fixture command",
      );
      const heartbeat = path.join(session.workspace, "heartbeat");
      await until(
        async () =>
          (await readFile(heartbeat, "utf8").catch(() => "")).length >= 4,
        "heartbeats",
      );
      engine.cancel(task.id);
      await settled(task, "cancelled");
      const before = await readFile(heartbeat, "utf8");
      await delay(400);
      assert.equal(await readFile(heartbeat, "utf8"), before);
      assert.deepEqual(await readdir(path.join(data, "mxc", "active")), []);
    },
  );

  await check(
    "service shutdown persists interruption; fresh Store and factory recover manually",
    async () => {
      providerMode = "pending";
      const session = await workspace("interrupt-workspace");
      const task = engine.start(session.id, "interrupt pending fixture model");
      await until(() => modelEntered, "model callback");
      await engine.close();
      assert.equal(store.task(task.id).status, "interrupted");
      await store.closeAsync();
      store = new Store(db);
      providerMode = "recover";
      engine = newEngine();
      assert.equal(store.task(task.id).status, "interrupted");
      const recovered = engine.resume(task.id, "continue without replay");
      await settled(recovered, "completed");
      assert.equal(
        counts
          .filter((entry) => entry.mode === "pending")
          .reduce((sum, entry) => sum + entry.calls, 0),
        1,
      );
    },
  );

  await check(
    "persisted context continuation does not repeat prior edits",
    async () => {
      providerMode = "resume";
      const task = engine.start(originalSession.id, "read prior artifact");
      await settled(task, "completed");
      const tools = store.replayCase(task.id).capture.tools;
      assert.deepEqual(
        tools.map((entry) => entry.name),
        ["read_file"],
      );
      assert.match(JSON.stringify(tools[0].result), /created-by-runtime/);
      assert.deepEqual(await readdir(path.join(data, "mxc", "active")), []);
    },
  );
} finally {
  report.currentCase = "cleanup";
  process.stdout.write("START cleanup\n");
  await saveReport();
  await engine.close();
  await store.closeAsync();
  report.currentCase = "finished";
  await saveReport();
  process.stdout.write("PASS cleanup\n");
}

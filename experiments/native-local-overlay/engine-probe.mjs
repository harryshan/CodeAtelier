/**
 * 手动验证 Linux namespace 中真实 Engine 的 Local overlay 模型工具闭环。
 * 1. 使用独占源码、真实 SQLite、生产平台工厂和 MXC Runtime；固定内存 provider 不访问模型服务。
 * 2. 两个模型屏障保证并行 Runtime 从同一 B 编辑，并经 local_publish IPC 明确选择源码。
 * 3. Engine 排空任务后调用候选 Sandbox 和 Publisher，检查三方合并、事件、私有产物及租约。
 *    命令在新私有子目录初始化 Git；metadata 留在 upper，不阻断源码发布、不进入候选或来源。
 * 4. 保存夹具报告与生产日志；失败保留现场，正常关闭 Engine/Store，不运行 Evaluation。
 * 5. --http 使用生产 Fastify/异步 Store Workers/SandboxBroker，经真实回环 HTTP/SSE 创建与启动；只指定真实 MXC 的安装路径。
 *    --browser 最多保留五分钟供真实页面核对，操作者写入夹具 browser-done 后正常关闭。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Engine } from "../../src/agent/engine.ts";
import { Config } from "../../src/config/config.ts";
import { createLogger } from "../../src/logging/logger.ts";
import { Store } from "../../src/sessions/store.ts";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { createApp } from "../../src/server/app.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
const source = path.join(root, "source");
await mkdir(source);
await mkdir(path.join(source, ".git"));
await writeFile(path.join(source, ".git", "sentinel"), "private metadata");
await writeFile(path.join(source, "module.py"), "a = 1\nb = 2\n");
process.env.CODEATELIER_SANDBOX_ENABLED = "true";
process.env.CODEATELIER_BASE_URL = "http://127.0.0.1:1/v1";
process.env.CODEATELIER_MODEL = "local-overlay-verification";
process.env.CODEATELIER_API_KEY = "";
const config = new Config(path.join(root, "data"));
config.settings.maxConcurrentTasks = 2;
config.settings.maxSteps = 4;
const log = createLogger(root, "debug");
const http = process.argv.includes("--http");
const sdk = await import(pathToFileURL(sdkEntry).href);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const python = (value) => `python3 -B -c ${quote(value)}`;
const report = {
  passed: false,
  parallel: false,
  http,
  tasks: [],
  publications: [],
  refreshes: 0,
};
const calls = new Map();
const intervals = new Map();

function barrier() {
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async (signal) => {
    signal.throwIfAborted();
    if (++arrived === 2) {
      release();
    }
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void ready.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  };
}

const started = barrier();
const edited = barrier();
function tool(name, id, args) {
  return {
    text: "",
    output: [
      {
        type: "function_call",
        call_id: id,
        name,
        arguments: JSON.stringify({
          execution: { id, dependsOn: [] },
          arguments: args,
        }),
      },
    ],
  };
}

const provider = {
  async run(input, instructions, tools, signal) {
    assert.match(instructions, /private Local overlay view/);
    assert.ok(tools.some((entry) => entry.name === "local_publish"));
    const serialized = JSON.stringify(input);
    const label = /ENGINE_LINUX_([AB])/.exec(serialized)?.[1];
    assert.ok(label);
    const count = calls.get(label) ?? 0;
    calls.set(label, count + 1);
    if (count === 0) {
      await started(signal);
      const content = label === "A" ? "a = 10\nb = 2\n" : "a = 1\nb = 20\n";
      return tool("run_command", `${label}-edit`, {
        command: python(
          `import pathlib,time,subprocess; p=pathlib.Path('module.py'); assert p.read_text()=='a = 1\\nb = 2\\n'; assert not pathlib.Path('.git').exists(); start=time.time_ns(); time.sleep(0.5); p.write_text(${JSON.stringify(content)}); pathlib.Path('artifact').write_text('private'); pathlib.Path('nested').mkdir(); subprocess.run(['git','-C','nested','init'],check=True,capture_output=True); print('ENGINE_INTERVAL_${label}:'+str(start)+':'+str(time.time_ns()))`,
        ),
      });
    }
    if (count === 1) {
      const match = new RegExp(`ENGINE_INTERVAL_${label}:(\\d+):(\\d+)`).exec(
        serialized,
      );
      assert.ok(match, "Runtime edit did not complete");
      intervals.set(label, [BigInt(match[1]), BigInt(match[2])]);
      await edited(signal);
      assert.equal(
        await readFile(path.join(source, "module.py"), "utf8"),
        "a = 1\nb = 2\n",
      );
      return tool("local_publish", `${label}-select`, {
        request: {
          action: "select",
          paths: ["module.py"],
          commands: [
            python(
              `import pathlib; p=pathlib.Path('module.py'); assert '${label === "A" ? "a = 10" : "b = 20"}' in p.read_text(); assert not pathlib.Path('artifact').exists(); assert not pathlib.Path('.git').exists(); print('ENGINE_CANDIDATE_OK')`,
            ),
          ],
        },
      });
    }
    assert.equal(count, 2);
    const receipt = input.find(
      (entry) =>
        entry.type === "function_call_output" &&
        entry.call_id === `${label}-select`,
    );
    assert.ok(receipt);
    assert.deepEqual(JSON.parse(receipt.output), {
      selected: 1,
      published: false,
    });
    return {
      text: "Selection registered; Engine will validate and publish after drain.",
      output: [],
    };
  },
};

let runtime;
const factory = (_settings, purpose) =>
  purpose === "task"
    ? provider
    : { run: async () => ({ text: "Linux overlay probe", output: [] }) };
const server = http ? await createApp(config, log, factory) : undefined;
const store =
  server?.store ??
  new Store(path.join(config.directory, "history.sqlite"), { inline: true });
const engine =
  server?.engine ??
  new Engine(store, config, log, factory, {
    launch: (input) => runtime.launchTask(input),
  });
runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory: config.directory,
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces: engine.traces,
  log,
  loadSdk: async () => sdk,
});
if (server) {
  // 仅为当前实验指定既有 SDK/bundle 路径，保留工厂创建的 Runtime 和完整 SandboxBroker。
  // 不向产品 HTTP 或设置开放这些测试注入项，也不替换真实 self-check/launch/cleanup。
  assert.ok(engine.sandbox.runtime instanceof MxcSandboxRuntime);
  Object.assign(engine.sandbox.runtime.options, {
    bundleDirectory,
    nodeExecutable: process.execPath,
    loadSdk: async () => sdk,
  });
}

let address;
let headers;
const streams = [];
async function request(route, payload) {
  const response = await fetch(address + route, {
    method: payload === undefined ? "GET" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function watch(sessionId) {
  const abort = new AbortController();
  const response = await fetch(`${address}/api/sessions/${sessionId}/events`, {
    headers,
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const done = (async () => {
    try {
      for await (const chunk of response.body) {
        report.refreshes +=
          Buffer.from(chunk).toString().split("event: refresh").length - 1;
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        throw error;
      }
    }
  })();
  streams.push({ abort, done });
}

try {
  if (server) {
    address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.localOverlayCreation.enabled, true);
    headers = {
      cookie: `ca_session=${bootstrap.token}`,
      "x-codeatelier-token": bootstrap.token,
    };
  }
  const sessions = [];
  for (const label of ["A", "B"]) {
    const id = randomUUID();
    const session = server
      ? await request("/api/sessions", {
          workspace: source,
          localOverlay: { id },
        })
      : await engine.localOverlays.create({ id, source }, async (workspace) =>
          store.create(workspace, `Linux Engine ${label}`),
        );
    sessions.push(session);
    if (server) {
      assert.equal(session.localOverlay.fileReviewSupported, false);
      assert.equal(session.localOverlay.projectWorkspace, source);
      assert.equal(
        (
          await request("/api/sessions", {
            workspace: source,
            localOverlay: { id },
          })
        ).id,
        session.id,
      );
      await watch(session.id);
    }
  }
  const tasks = [];
  for (const [index, session] of sessions.entries()) {
    tasks.push(
      server
        ? await request(`/api/sessions/${session.id}/tasks`, {
            prompt: `ENGINE_LINUX_${index === 0 ? "A" : "B"}: run the fixed probe.`,
          })
        : await engine.start(
            session.id,
            `ENGINE_LINUX_${index === 0 ? "A" : "B"}: run the fixed probe.`,
          ),
    );
  }
  const deadline = performance.now() + 90000;
  while (await engine.hasActiveTasks()) {
    assert.ok(performance.now() < deadline, "Engine verification timed out");
    await delay(100);
  }
  for (const [index, task] of tasks.entries()) {
    const events = (await store.events(sessions[index].id)).filter(
      (event) => event.taskId === task.id,
    );
    const saved = await store.task(task.id);
    report.tasks.push({ task: saved, events });
    assert.equal(saved?.status, "completed");
    assert.ok(
      events.some(
        (event) =>
          event.type === "execution_instance" &&
          event.data.kind === "agent-runtime" &&
          event.data.mode === "linux-bubblewrap" &&
          event.data.state === "completed" &&
          event.data.sandboxApplied,
      ),
    );
    assert.ok(
      !events.some(
        (event) =>
          ["sandbox_fallback", "sandbox_warning"].includes(event.type) ||
          (event.type === "execution_instance" &&
            event.data.state === "unknown"),
      ),
    );
    const publication = events.find(
      (event) => event.type === "local_overlay" && event.data.published,
    );
    assert.ok(publication, "Engine did not publish selection");
    assert.ok(events.some((event) => event.type === "local_validation"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "execution_instance" &&
          event.data.purpose === "local-validation" &&
          event.data.mode === "linux-bubblewrap" &&
          event.data.state === "completed" &&
          event.data.sandboxApplied,
      ),
    );
    report.publications.push(publication.data);
    const record = await engine.localOverlays.validate(
      sessions[index].workspace,
      sessions[index].id,
    );
    assert.equal(record.phase, "ready");
    assert.equal(record.epoch, 1);
    if (server) {
      assert.ok(
        events.some(
          (event) =>
            event.type === "sandbox_stage" &&
            event.data.applied === true &&
            event.data.level === "linux-bubblewrap-mxc-v1",
        ),
      );
      const snapshot = await request(`/api/sessions/${sessions[index].id}`);
      assert.equal(snapshot.session.localOverlay.state, "ready");
      assert.equal(
        snapshot.session.localOverlay.publication.state,
        "published",
      );
      assert.equal(snapshot.session.localOverlay.fileReviewSupported, false);
      const denied = await fetch(
        `${address}/api/sessions/${sessions[index].id}/local-review`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ path: "module.py" }),
        },
      );
      assert.equal(denied.status, 409);
      await denied.arrayBuffer();
    }
    assert.match(
      await readFile(
        path.join(
          config.directory,
          "local-overlays",
          record.id,
          "upper",
          "nested",
          ".git",
          "HEAD",
        ),
        "utf8",
      ),
      /^ref: refs\/heads\//,
    );
  }
  const a = intervals.get("A");
  const b = intervals.get("B");
  assert.ok(a[0] < b[1] && b[0] < a[1]);
  report.parallel = true;
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    "a = 10\nb = 20\n",
  );
  assert.deepEqual((await readdir(source)).sort(), [".git", "module.py"]);
  assert.deepEqual(
    await readdir(path.join(config.directory, "mxc", "active")),
    [],
  );
  if (server) {
    assert.ok(report.refreshes > 2);
    assert.equal((await request("/api/sessions")).length, 2);
    // bootstrap 表示下次启动前的配置，不是已完成任务的证明；实际隔离由上面的任务事件断言。
    report.initialSandbox = (await request("/api/bootstrap")).sandbox;
    assert.equal(report.initialSandbox.enabled, true);
    if (process.argv.includes("--browser")) {
      await writeFile(
        path.join(root, "browser-ready.json"),
        JSON.stringify({
          address,
          sessions: sessions.map((session) => session.id),
          source,
        }),
      );
      const deadline = performance.now() + 300000;
      while (true) {
        try {
          await access(path.join(root, "browser-done"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        assert.ok(
          performance.now() < deadline,
          "Browser verification timed out",
        );
        await delay(200);
      }
    }
  }
  report.passed = true;
} finally {
  await writeFile(
    path.join(root, "engine-report.json"),
    JSON.stringify(report, null, 2),
  );
  for (const stream of streams) {
    stream.abort.abort();
  }
  if (server) {
    // 服务关闭负责结束 SSE；不能先等待客户端 reader，部分 Node 版本的 abort 会延迟到流结束。
    await server.shutdown();
  } else {
    await engine.close();
    await store.close();
  }
  await Promise.all(streams.map((stream) => stream.done));
  report.closed = true;
  await writeFile(
    path.join(root, "engine-report.json"),
    JSON.stringify(report, null, 2),
  );
}

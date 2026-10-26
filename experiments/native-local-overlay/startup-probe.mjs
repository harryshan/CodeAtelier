/**
 * 手动验收正式 Linux 构建/启动入口，不替换 Engine、SandboxBroker 或 MXC Runtime。
 * 1. 将当前编译产物装配到独占夹具；复用现有纯 JS 依赖和调用者指定的 Linux MXC 安装。
 *    Windows node_modules 的 Koffi 原生模块不能在 Linux 使用，故仅在夹具安装树中绑定 Linux SDK。
 * 2. 回环 Responses HTTP/SSE 返回固定工具计划，两阶段屏障确保双会话从同一基线并行编辑。
 * 3. 保存独立 v1 设置，启动 dist 的 overlay-launcher，由实际 HTTP 创建/运行会话；没有内部类注入。
 * 4. 核对真实 Runtime/候选、来源合并、私有产物，重载服务后继续原会话读取，再正常退出并保留报告。
 * 5. finally 仅关闭本脚本服务/子进程；不安装依赖、不修改用户设置、不重启现有服务或运行 Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.platform, "linux");
const [root, linuxSdk] = process.argv.slice(2);
assert.ok(root && path.isAbsolute(root));
assert.ok(linuxSdk && path.isAbsolute(linuxSdk));
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const app = path.join(root, "app");
const data = path.join(root, "data");
const views = path.join(root, "views");
const source = path.join(root, "source");
await mkdir(app);
await mkdir(data, { mode: 0o700 });
await mkdir(source);
await writeFile(path.join(source, "module.py"), "a = 1\nb = 2\n");
await writeFile(path.join(app, "package.json"), '{"type":"module"}\n');
for (const directory of [
  "server",
  "runtime/posix",
  `native/linux-${process.arch}`,
]) {
  await cp(
    path.join(checkout, "dist", directory),
    path.join(app, "dist", directory),
    {
      recursive: true,
      errorOnExist: true,
      force: false,
    },
  );
}
await symlink(path.join(checkout, "dist/web"), path.join(app, "dist/web"));
const modules = path.join(app, "node_modules");
await mkdir(path.join(modules, "@microsoft"), { recursive: true });
for (const name of await readdir(path.join(checkout, "node_modules"))) {
  if (!name.startsWith(".") && name !== "@microsoft") {
    await symlink(
      path.join(checkout, "node_modules", name),
      path.join(modules, name),
    );
  }
}
await symlink(linuxSdk, path.join(modules, "@microsoft/mxc-sdk"));
const { defaultDocument } = await import(
  pathToFileURL(path.join(app, "dist/server/config/settings-document.js")).href
);

const report = { passed: false, closed: false, tasks: [], requests: 0 };
const calls = new Map();
const intervals = new Map();
function barrier() {
  let count = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++count === 2) {
      release();
    }
    await ready;
  };
}
const started = barrier();
const edited = barrier();
const python = (code) => `python3 -B -c '${code.replaceAll("'", "'\\''")}'`;
function tool(label, step, name, args) {
  const id = `${label}-${step}`;
  return [
    {
      type: "function_call",
      call_id: id,
      name,
      arguments: JSON.stringify({
        execution: { id, dependsOn: [] },
        arguments: args,
      }),
    },
  ];
}
function message() {
  return [
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Fixed Linux startup verification." },
      ],
    },
  ];
}
async function respond(body) {
  if (!body.tools?.some((entry) => entry.name === "local_publish")) {
    return message();
  }
  const serialized = JSON.stringify(body.input);
  if (serialized.includes("STARTUP_CONTINUE")) {
    const step = calls.get("continue") ?? 0;
    calls.set("continue", step + 1);
    if (step === 0) {
      return tool("continue", step, "run_command", {
        command: python(
          "import pathlib; assert pathlib.Path('module.py').read_text()=='a = 10\\nb = 20\\n'; assert pathlib.Path('artifact').read_text()=='private'; print('CONTINUE_OK')",
        ),
      });
    }
    assert.equal(step, 1);
    assert.match(serialized, /CONTINUE_OK/);
    return message();
  }
  const label = /STARTUP_LINUX_([AB])/.exec(serialized)?.[1];
  assert.ok(label);
  const step = calls.get(label) ?? 0;
  calls.set(label, step + 1);
  if (step === 0) {
    await started();
    const content = label === "A" ? "a = 10\nb = 2\n" : "a = 1\nb = 20\n";
    return tool(label, step, "run_command", {
      command: python(
        `import pathlib,time; p=pathlib.Path('module.py'); assert p.read_text()=='a = 1\\nb = 2\\n'; start=time.time_ns(); time.sleep(0.5); p.write_text(${JSON.stringify(content)}); pathlib.Path('artifact').write_text('private'); print('INTERVAL_${label}:'+str(start)+':'+str(time.time_ns()))`,
      ),
    });
  }
  if (step === 1) {
    const match = new RegExp(`INTERVAL_${label}:(\\d+):(\\d+)`).exec(
      serialized,
    );
    assert.ok(match, "Runtime did not complete the fixed edit");
    intervals.set(label, [BigInt(match[1]), BigInt(match[2])]);
    await edited();
    assert.equal(
      await readFile(path.join(source, "module.py"), "utf8"),
      "a = 1\nb = 2\n",
    );
    return tool(label, step, "local_publish", {
      request: {
        action: "select",
        paths: ["module.py"],
        commands: [
          python(
            `import pathlib; assert '${label === "A" ? "a = 10" : "b = 20"}' in pathlib.Path('module.py').read_text(); assert not pathlib.Path('artifact').exists()`,
          ),
        ],
      },
    });
  }
  assert.equal(step, 2);
  return message();
}
const model = createServer((request, response) => {
  void (async () => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-startup-fixture" }] }));
      return;
    }
    assert.equal(request.url, "/v1/responses");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    report.requests++;
    const output = await respond(JSON.parse(text));
    response.setHeader("content-type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    );
  })().catch((error) => {
    report.modelError = error.message;
    response.statusCode = 500;
    response.end("Fixed verification failed");
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const settings = defaultDocument();
settings.models.main = {
  ...settings.models.main,
  baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
  model: "local-startup-fixture",
  apiKey: "synthetic-placeholder",
};
settings.server.port = port;
settings.sandbox.enabled = true;
settings.execution.maxConcurrentTasks = 2;
settings.execution.maxSteps = 4;
await writeFile(path.join(data, "settings.json"), JSON.stringify(settings), {
  mode: 0o600,
});
const log = createWriteStream(path.join(root, "service.log"));
const child = spawn(
  process.execPath,
  [
    path.join(app, "dist/server/server/overlay-launcher.js"),
    "--data-dir",
    data,
    "--views",
    views,
  ],
  { cwd: app, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const url = `http://127.0.0.1:${port}`;
let headers = {};
let ready = false;
async function request(route, body) {
  const response = await fetch(url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  const deadline = performance.now() + 90000;
  let bootstrap;
  while (!bootstrap) {
    assert.ok(
      child.exitCode === null && child.signalCode === null,
      "Startup exited before ready",
    );
    assert.ok(performance.now() < deadline, "Startup timed out");
    try {
      bootstrap = await request("/api/bootstrap");
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") {
        throw error;
      }
      await delay(100);
    }
  }
  ready = true;
  headers = {
    cookie: `ca_session=${bootstrap.token}`,
    "x-codeatelier-token": bootstrap.token,
  };
  assert.equal(bootstrap.localOverlayCreation.enabled, true);
  const sessions = [];
  for (const label of ["A", "B"]) {
    const session = await request("/api/sessions", {
      workspace: source,
      localOverlay: { id: randomUUID() },
    });
    await request(`/api/sessions/${session.id}/tasks`, {
      prompt: `STARTUP_LINUX_${label}: execute the fixed verification.`,
    });
    sessions.push(session);
  }
  for (const session of sessions) {
    let snapshot;
    do {
      assert.ok(performance.now() < deadline, "Tasks timed out");
      snapshot = await request(`/api/sessions/${session.id}`);
      await delay(100);
    } while (
      snapshot.tasks.some((task) => ["queued", "running"].includes(task.status))
    );
    assert.equal(snapshot.tasks[0].status, "completed");
    const executions = snapshot.events
      .filter(
        (event) =>
          event.type === "execution_instance" &&
          event.data.state === "completed",
      )
      .map((event) => ({
        kind: event.data.kind,
        purpose: event.data.purpose ?? null,
        mode: event.data.mode,
        sandboxApplied: event.data.sandboxApplied,
      }));
    assert.equal(executions.length, 2);
    assert.ok(
      executions.every(
        (entry) =>
          entry.kind === "agent-runtime" &&
          entry.mode === "linux-bubblewrap" &&
          entry.sandboxApplied,
      ),
    );
    assert.ok(executions.some((entry) => entry.purpose === "local-validation"));
    assert.equal(snapshot.session.localOverlay.publication.state, "published");
    assert.equal(snapshot.session.localOverlay.state, "ready");
    assert.equal(
      await readFile(
        path.join(
          data,
          "local-overlays",
          session.localOverlay.id,
          "upper/artifact",
        ),
        "utf8",
      ),
      "private",
    );
    report.tasks.push({
      status: snapshot.tasks[0].status,
      executions,
      publication: snapshot.session.localOverlay.publication,
    });
  }
  const a = intervals.get("A");
  const b = intervals.get("B");
  assert.ok(a[0] < b[1] && b[0] < a[1]);
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    "a = 10\nb = 20\n",
  );
  assert.deepEqual(await readdir(source), ["module.py"]);
  assert.deepEqual(await readdir(path.join(data, "mxc/active")), []);

  // 重载只替换 supervisor 的服务子进程；新 bootstrap token 证明读取的不是旧进程快照。
  await request("/api/server/reload", { confirm: true });
  const reloadDeadline = performance.now() + 45000;
  while (true) {
    assert.ok(performance.now() < reloadDeadline, "Service reload timed out");
    try {
      const response = await fetch(`${url}/api/bootstrap`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) {
        const next = await response.json();
        if (next.token !== bootstrap.token) {
          assert.equal(next.localOverlayCreation.enabled, true);
          headers = {
            cookie: `ca_session=${next.token}`,
            "x-codeatelier-token": next.token,
          };
          break;
        }
      } else {
        assert.equal(response.status, 503);
        await response.arrayBuffer();
      }
    } catch (error) {
      if (
        error.cause?.code !== "ECONNREFUSED" &&
        error.cause?.code !== "UND_ERR_SOCKET"
      ) {
        throw error;
      }
    }
    await delay(100);
  }
  const continuation = await request(`/api/sessions/${sessions[0].id}/tasks`, {
    prompt:
      "STARTUP_CONTINUE: verify the merged source and retained private artifact.",
  });
  let continued;
  const continueDeadline = performance.now() + 45000;
  do {
    assert.ok(performance.now() < continueDeadline, "Continuation timed out");
    continued = await request(`/api/sessions/${sessions[0].id}`);
    await delay(100);
  } while (
    continued.tasks.some(
      (task) =>
        task.id === continuation.id &&
        ["queued", "running"].includes(task.status),
    )
  );
  assert.equal(
    continued.tasks.find((task) => task.id === continuation.id)?.status,
    "completed",
  );
  assert.ok(
    continued.events.some(
      (event) =>
        event.taskId === continuation.id &&
        event.type === "execution_instance" &&
        event.data.state === "completed" &&
        event.data.sandboxApplied &&
        event.data.mode === "linux-bubblewrap",
    ),
  );
  assert.equal(continued.session.localOverlay.state, "ready");
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    "a = 10\nb = 20\n",
  );
  assert.deepEqual(await readdir(path.join(data, "mxc/active")), []);
  report.reloaded = true;
  report.continued = true;
  report.passed = true;
  report.parallel = true;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (ready) {
      await request("/api/server/shutdown", { confirm: true });
    } else {
      child.kill("SIGTERM");
    }
  }
  report.exit = await Promise.race([
    exited,
    delay(20000, { timeout: true }, { ref: false }),
  ]);
  report.closed = report.exit.code === 0;
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  log.end();
  await writeFile(
    path.join(root, "startup-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  assert.ok(report.closed, "Production launcher did not exit cleanly");
}

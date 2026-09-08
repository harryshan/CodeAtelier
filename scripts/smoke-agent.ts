import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { Engine } from "../src/agent/engine.js";

if (!process.env.CODEATELIER_API_KEY) {
  throw new Error("Set CODEATELIER_API_KEY");
}

await mkdir(".local", { recursive: true });

const root = await realpath(await mkdtemp(path.resolve(".local/smoke-")));

const workspace = path.join(root, "workspace");

await mkdir(workspace);

await writeFile(
  path.join(workspace, "math.mjs"),
  "export const add = (a, b) => a - b;\n",
);

await writeFile(
  path.join(workspace, "math.test.mjs"),
  "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './math.mjs';\ntest('positive addition',()=>assert.equal(add(2,3),5));\n",
);

const config = new Config(path.join(root, "data"));

config.settings.maxSteps = 12;

const store = new Store(path.join(config.directory, "history.sqlite"));

const session = store.create(workspace, "真实模型闭环验收");

const engine = new Engine(store, config, pino({ enabled: false }));

engine.events.on("change", () => {
  for (const approval of engine.approvals.list()) {
    let allow = false;

    try {
      const d = JSON.parse(approval.description);

      allow =
        approval.tool === "run_command" &&
        [process.execPath, "node"].includes(d.command) &&
        JSON.stringify(d.args) === '["--test"]' &&
        d.cwd === workspace;
    } catch {
      /* Only the fixed test command is preauthorized. */
    }

    console.log(
      JSON.stringify({
        approval: approval.tool,
        decision: allow ? "allow" : "deny",
      }),
    );
    engine.approvals.decide(approval.id, allow ? "once" : "deny");
  }
});

engine.events.on("event", (e) => {
  if (["tool_start", "tool_result", "notice", "task_end"].includes(e.type)) {
    console.log(
      JSON.stringify({
        type: e.type,
        name: e.data.name,
        status: e.data.status,
        error: e.data.result?.error,
        text: e.type === "notice" ? e.data.text : undefined,
      }),
    );
  }
});

const task = engine.start(
  session.id,
  `请修复 math.mjs 的 add 函数，并在 math.test.mjs 精确增加一个负数相加的测试。使用 read_file 和 edit_file，不要覆盖整个文件。然后使用 run_command 运行测试：command 为 ${JSON.stringify(process.execPath)}，args 为 ["--test"]，cwd 为 "."。根据真实测试结果报告。不要运行其他命令。`,
);

const timeout = setTimeout(() => engine.cancel(task.id), 240000);

await engine.active!.done;

clearTimeout(timeout);

const events = store.events(session.id);

const result = store.tasks(session.id)[0];

const verified = events.some(
  (e) =>
    e.type === "tool_result" &&
    e.data.name === "run_command" &&
    e.data.result?.exitCode === 0,
);

console.log(
  JSON.stringify({
    status: result.status,
    verified,
    workspace,
    source: await readFile(path.join(workspace, "math.mjs"), "utf8"),
  }),
);

store.close();

if (result.status !== "completed" || !verified) {
  process.exitCode = 1;
}

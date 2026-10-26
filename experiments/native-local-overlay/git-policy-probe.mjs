/**
 * 手动检查原生 OverlayFS 对 Git 管理目录的实际边界，不把 lower 隐藏当作 upper 写入策略。
 * 1. 正式 namespace 控制器创建独占视图，来源含根和嵌套 .git 哨兵。
 * 2. 真实 MXC Runtime 在根、既有目录和纯 upper 新目录测试发现、创建、链接、重命名和 git init。
 * 3. 保存每项 errno/退出码并确认来源没有变化；诊断模式允许记录当前限制，--require-root 拒绝根绕过。
 * 4. 正常排空、卸载；不使用用户仓库、模型服务或 Evaluation，不开放产品入口。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { LinuxOverlayController } from "../../src/local-overlays/linux-controller.ts";
import { TraceRecorder } from "../../src/tracing/recorder.ts";
import { TraceArchive } from "../../src/tracing/archive.ts";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { runCandidateCommands } from "../../src/local-overlays/command-runtime.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
const source = path.join(root, "source");
for (const directory of [".git", "existing/.git"]) {
  await mkdir(path.join(source, directory), { recursive: true });
  await writeFile(path.join(source, directory, "sentinel"), "hidden");
}
const log = pino({ enabled: false });
const traces = new TraceRecorder();
const archive = new TraceArchive(root, log);
const controller = new LinuxOverlayController(
  process.env.CODEATELIER_OVERLAY_SOCKET,
  log,
  traces,
  archive,
);
const sdk = await import(pathToFileURL(sdkEntry).href);
const runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory: path.join(root, "data"),
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces,
  log,
  loadSdk: async () => sdk,
});
const id = randomUUID();
const view = await controller.open(id, source, true);
const taskId = randomUUID();
traces.startTask(taskId, id);
const code = `import pathlib,os,json,subprocess,shutil
results=[]
assert not pathlib.Path('.git/sentinel').exists()
assert not pathlib.Path('existing/.git/sentinel').exists()
pathlib.Path('new').mkdir()
for directory in ['.', 'existing', 'new']:
 parent=pathlib.Path(directory)
 target=parent/'.git'
 status=subprocess.run(['git','-C',directory,'status','--porcelain'],capture_output=True)
 results.append(dict(directory=directory,operation='status',exitCode=status.returncode))
 for operation in ['mkdir','file','symlink','rename','init']:
  attempt=dict(directory=directory,operation=operation)
  try:
   if operation=='mkdir': target.mkdir()
   elif operation=='file': target.write_text('private')
   elif operation=='symlink': target.symlink_to('nonexistent')
   elif operation=='rename':
    (parent/'rename-source').mkdir()
    (parent/'rename-source').rename(target)
   else:
    result=subprocess.run(['git','-C',directory,'init'],capture_output=True)
    attempt['exitCode']=result.returncode
   attempt['allowed']=os.path.lexists(target)
  except OSError as error:
   attempt['allowed']=False
   attempt['errno']=error.errno
  results.append(attempt)
  if target.is_symlink() or target.is_file(): target.unlink()
  elif target.is_dir(): shutil.rmtree(target)
  if (parent/'rename-source').exists(): (parent/'rename-source').rmdir()
pathlib.Path('policy.json').write_text(json.dumps(results))`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let drained = false;
let passed = false;
try {
  const execution = await runCandidateCommands({
    launcher: { launch: (value) => runtime.launchTask(value) },
    traces,
    log,
    sessionId: id,
    taskId,
    workspace: view.workspace,
    commands: [`python3 -B -c ${quote(code)}`],
    signal: AbortSignal.timeout(60000),
    emit: async () => {},
  });
  drained = execution.drained;
  assert.deepEqual(execution, {
    drained: true,
    sandboxApplied: true,
    exitCode: 0,
  });
  const attempts = JSON.parse(
    await readFile(path.join(view.workspace, "policy.json"), "utf8"),
  );
  const report = {
    execution,
    attempts,
    rootDenied: attempts
      .filter((item) => item.directory === "." && item.operation !== "status")
      .every((item) => !item.allowed),
    sourceUnchanged: (await readdir(source)).sort().join() === ".git,existing",
  };
  for (const directory of [".git", "existing/.git"]) {
    assert.equal(
      await readFile(path.join(source, directory, "sentinel"), "utf8"),
      "hidden",
    );
    assert.deepEqual(await readdir(path.join(source, directory)), ["sentinel"]);
  }
  await writeFile(
    path.join(root, "git-policy-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  assert.ok(report.sourceUnchanged);
  assert.ok(
    attempts
      .filter((item) => item.operation === "status")
      .every((item) => item.exitCode !== 0),
  );
  if (process.argv.includes("--require-root")) {
    assert.ok(report.rootDenied, "Root Git metadata creation allowed");
    assert.ok(
      attempts
        .filter(
          (item) =>
            item.directory === "existing" && item.operation !== "status",
        )
        .every((item) => !item.allowed),
      "Existing lower directory allowed Git metadata creation",
    );
  }
  passed = true;
} finally {
  if (drained) {
    await controller.close(id);
  }
  traces.finishTask(taskId, passed ? "ok" : "error");
  await archive.write(id, taskId, traces.exportTask(taskId));
}

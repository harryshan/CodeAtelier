/**
 * commit-backed PoC 的真实安装态 Sandbox 验证，供人工 PoC 脚本调用。
 * 1. 固定内存模型在虚拟卷读取已提交文件、写入并 Git commit，不访问真实模型服务。
 * 2. 实验适配器只向现有 Engine 提供已验证挂载身份和 common Git root；不替换 Runtime/ACL/IPC。
 * 3. 核对专用账户、agent-runtime/sandboxApplied、完成/取消和租约释放；fallback 必须失败。
 * 不安装/Repair、不重启服务，Engine 排空后由调用方卸载；产品 WorktreeService 尚未接入此模式。
 */
import assert from "node:assert/strict";
import path from "node:path";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { VirtualWorktree } from "./virtual-worktree-fixture.js";

export async function verifyVirtualSandbox(view: VirtualWorktree) {
  process.env.CODEATELIER_SANDBOX_ENABLED = "true";
  process.env.CODEATELIER_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.CODEATELIER_MODEL = "virtual-worktree-verification";
  process.env.CODEATELIER_API_KEY = "";
  const config = new Config(path.join(view.root, "sandbox-data"));
  config.settings.maxSteps = 3;
  const store = new Store(path.join(config.directory, "history.sqlite"));
  let calls = 0;
  let cancelMode = false;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
      };
    },
    async run(input, _instructions, _tools, signal) {
      if (cancelMode) {
        entered();
        signal.throwIfAborted();

        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }

      if (calls++ === 0) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "virtual-command",
              name: "run_command",
              arguments: JSON.stringify({
                execution: { id: "probe", dependsOn: [] },
                arguments: {
                  command:
                    "whoami; $base = Get-Content -LiteralPath 'd00000/f0000000.txt' -Raw; if (-not $base.StartsWith('0:')) { throw 'Wrong Git base' }; Set-Content -LiteralPath 'runtime.txt' -Value 'private'; git add runtime.txt; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git -c commit.gpgsign=false commit -m 'virtual runtime'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output 'VIRTUAL_RUNTIME_GIT_OK'",
                },
              }),
            },
          ],
        };
      }

      assert.match(JSON.stringify(input), /codeateliersandbox/i);
      assert.match(JSON.stringify(input), /VIRTUAL_RUNTIME_GIT_OK/);

      return { text: "verified", output: [] };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );
  // Only the experimental workspace registration adapter is substituted.
  // All execution, grants, root identities, IPC and cleanup are production code.
  engine.worktrees.validate = async (workspace) => {
    await view.validate(workspace);

    return undefined;
  };

  engine.worktrees.gitWriteRoots = async (workspace) => {
    await view.validate(workspace);

    return [view.commonDirectory];
  };

  const session = store.create(
    view.workspace,
    "Virtual worktree Sandbox fixture",
  );
  function assertRuntime(taskId: string, state: "completed" | "cancelled") {
    const events = store
      .events(session.id)
      .filter((event) => event.taskId === taskId);
    assert(
      events.some(
        (event) =>
          event.type === "execution_instance" &&
          event.data.kind === "agent-runtime" &&
          event.data.mode === "windows-sandbox-user" &&
          event.data.state === state &&
          event.data.sandboxApplied === true,
      ),
    );
    assert(
      !events.some(
        (event) =>
          ["sandbox_fallback", "sandbox_warning"].includes(event.type) ||
          (event.type === "execution_instance" &&
            event.data.state === "unknown"),
      ),
    );
    assert.equal(
      engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
      0,
    );
    assert.equal(store.task(taskId)?.status, state);
  }

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Virtual Sandbox verification timed out")),
      90_000,
    );
  });
  try {
    const task = await engine.start(
      session.id,
      "Run the fixed virtual worktree probe.",
    );
    await Promise.race([engine.active!.done, deadline]);
    assertRuntime(task.id, "completed");
    cancelMode = true;
    const cancelled = await engine.start(
      session.id,
      "Wait for the fixed cancellation test.",
    );
    const done = engine.active!.done;
    await Promise.race([waiting, deadline]);
    engine.cancel(cancelled.id);
    await Promise.race([done, deadline]);
    assertRuntime(cancelled.id, "cancelled");
  } finally {
    clearTimeout(timer!);
    await engine.close();
    await store.closeAsync();
  }
}

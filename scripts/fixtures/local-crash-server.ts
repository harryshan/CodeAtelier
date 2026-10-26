/**
 * 手动真实服务崩溃验收的独占子进程，由 verify-local-server-crash 创建和终止。
 * 1. 从调用方夹具目录加载生产配置/createApp，只替换模型 provider；HTTP、WinFsp 和安装态 Runtime 均真实。
 * 2. crash 阶段让 Sandbox 打开文件、写入并 flush 前半段后等待，持久工具输出报告实际命令 PID。
 * 3. restart 阶段在新参考会话重新读取当前来源/部分参考，明确编辑并选择候选验证发布。
 * 4. IPC 仅向控制器报告监听地址和接受正常 stop；崩溃由控制器杀死本子进程，不修改清单/任务状态。
 * 不安装或 Repair，不访问真实模型，不重启用户服务；日志和历史仅写入指定独占夹具目录。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { Config } from "../../src/config/config.js";
import { createLogger } from "../../src/logging/logger.js";
import type { ModelProvider } from "../../src/providers/model-provider.js";
import { createApp } from "../../src/server/app.js";

const [root, phase] = process.argv.slice(2);
assert(root && (phase === "crash" || phase === "restart"));
let calls = 0;

function tool(id: string, name: string, args: unknown) {
  return {
    text: "",
    output: [
      {
        type: "function_call" as const,
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

const provider: ModelProvider = {
  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 64000, max_output_tokens: 1024 },
    };
  },
  async run(input, instructions) {
    if (!instructions.includes("private Local overlay view")) {
      return { text: "Local actual server crash", output: [] };
    }

    const count = calls++;
    if (phase === "crash") {
      assert.equal(
        count,
        0,
        "The interrupted command must never return to the provider",
      );

      return tool("crash-write", "run_command", {
        command: [
          "$ErrorActionPreference = 'Stop'",
          "whoami",
          "$file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('partial.txt')",
          "$stream = [System.IO.File]::Open($file, 'Create', 'Write', 'Read')",
          "$bytes = [System.Text.Encoding]::ASCII.GetBytes('private prefix only')",
          "$stream.Write($bytes, 0, $bytes.Length)",
          "$stream.Flush($true)",
          'Write-Output "CRASH_READY:$PID"',
          "Start-Sleep -Seconds 120",
          "$stream.WriteByte(33)",
          "$stream.Dispose()",
          "throw 'Controller did not interrupt the held write'",
        ].join("; "),
      });
    }

    assert.match(instructions, /partial operation/);
    const reference = /\.codeatelier-recovery-[a-f0-9-]{36}/.exec(
      instructions,
    )?.[0];
    assert(reference);
    if (count === 0) {
      return tool("recover-edit", "run_command", {
        command: [
          "$ErrorActionPreference = 'Stop'",
          "whoami",
          `$reference = Get-Content -LiteralPath '${reference}/manifest.json' -Raw | ConvertFrom-Json`,
          "if ($reference.version -ne 3 -or $reference.state -ne 'interrupted') { throw 'Wrong reference' }",
          "$entry = $reference.entries | Where-Object { $_.path -eq 'partial.txt' }",
          `if ((Get-Content -LiteralPath ('${reference}/' + $entry.directory + '/interrupted-private') -Raw) -ne 'private prefix only') { throw 'Partial reference lost' }`,
          "if ((Get-Content -LiteralPath 'partial.txt' -Raw) -ne 'current source') { throw 'Stale source' }",
          "Set-Content -LiteralPath 'partial.txt' -Value 'resolved after real crash' -NoNewline -Encoding ascii",
          "Write-Output 'RECOVER_EDITED'",
        ].join("; "),
      });
    }

    assert.match(JSON.stringify(input), /codeateliersandbox/i);
    if (count === 1) {
      assert.match(JSON.stringify(input), /RECOVER_EDITED/);

      return tool("recover-select", "local_publish", {
        request: {
          action: "select",
          paths: ["partial.txt"],
          commands: [
            `$ErrorActionPreference = 'Stop'; whoami; if ((Get-Content -LiteralPath 'partial.txt' -Raw) -ne 'resolved after real crash') { throw 'Wrong candidate' }; if (Test-Path -LiteralPath '${reference}') { throw 'Reference leaked' }`,
          ],
        },
      });
    }

    return {
      text: "Explicit new edit verified after actual server crash",
      output: [],
    };
  },
};

const server = await createApp(
  new Config(path.join(root, "data"), { legacy: false }),
  createLogger(root, "info"),
  () => provider,
);
const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ state: "ready", address });
process.on("message", (message) => {
  if (message === "stop") {
    void server.shutdown().then(() => process.disconnect());
  }
});

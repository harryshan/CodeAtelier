/**
 * 手动评测的命令行入口：读取参数和提示文件，调用 runEvaluation，并设置进程退出码。
 * 它复用后端引擎，不需要启动 Web UI。
 *
 * 1. 将 SIGINT、SIGTERM 接到取消信号，再解析工作目录、预算和命令审批选项。
 * 2. 检查必填参数、读取提示文件，把数值参数交给运行器继续校验。
 * 3. 根据任务结果设置退出码；异常时输出固定提示，最后移除信号监听。
 *
 * 只在用户要求时运行。错误提示不回显可能含密钥的参数；agent 正常完成仍需另行评分补丁。
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runEvaluation } from "./runner.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      output: { type: "string" },
      "prompt-file": { type: "string" },
      "max-total-tokens": { type: "string", default: "500000" },
      "max-model-calls": { type: "string", default: "60" },
      "max-steps": { type: "string", default: "30" },
      "timeout-ms": { type: "string", default: "600000" },
      "allow-workspace-commands": { type: "boolean", default: false },
    },
  });
  if (!values.workspace || !values.output || !values["prompt-file"]) {
    throw new Error(
      "Required: --workspace PATH --output PATH --prompt-file PATH",
    );
  }

  const report = await runEvaluation(
    {
      workspace: values.workspace,
      outputDir: values.output,
      prompt: await readFile(values["prompt-file"], "utf8"),
      maxTotalTokens: Number(values["max-total-tokens"]),
      maxModelCalls: Number(values["max-model-calls"]),
      maxSteps: Number(values["max-steps"]),
      timeoutMs: Number(values["timeout-ms"]),
      allowWorkspaceCommands: values["allow-workspace-commands"],
    },
    { signal: controller.signal },
  );
  process.exitCode = report.task.status === "completed" ? 0 : 1;
} catch {
  // 配置和参数可能含密钥，错误日志不能原样输出。
  process.stderr.write(
    "CodeAtelier evaluation failed. Check arguments and trial artifacts.\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

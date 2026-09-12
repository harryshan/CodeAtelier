/**
 * 文件作用：提供手动运行 Evaluation 的无界面命令入口。
 *
 * 模块协作与输入输出：
 * 供显式手动命令调用，不经过 Web UI；从命令行及 prompt 文件构造 runEvaluation 参数。
 *
 * 代码结构与执行顺序：
 * 1. 注册 SIGINT/SIGTERM 到 AbortController，再用 parseArgs 读取目录、预算及命令审批开关。
 * 2. 检查必要参数并读取提示文件，将字符串预算转为数值交给运行器继续校验。
 * 3. 根据任务终态设置进程退出码，异常时输出固定诊断，finally 移除信号监听。
 *
 * 关键约束：
 * 不回显可能含凭据的命令参数或异常；退出成功仅代表 agent 完成，不代表补丁通过官方评分。
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
  // Do not echo untrusted config/arguments or credentials to the evaluation command log.
  process.stderr.write(
    "CodeAtelier evaluation failed. Check arguments and trial artifacts.\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

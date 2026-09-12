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
  // Do not echo untrusted config/arguments or credentials to Harbor's command log.
  process.stderr.write(
    "CodeAtelier evaluation failed. Check arguments and trial artifacts.\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

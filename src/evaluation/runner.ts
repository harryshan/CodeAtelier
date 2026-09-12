import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { Engine } from "../agent/engine.js";
import { Config } from "../config/config.js";
import { createLogger } from "../logging/logger.js";
import { redactJson } from "../logging/redact.js";
import { ResponsesProvider } from "../providers/responses-provider.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { Store } from "../sessions/store.js";
import type { Approval } from "../shared/types.js";
import { inside } from "../tools/paths.js";
import { MeteredProvider } from "./metered-provider.js";
import { evaluationOptionsSchema } from "./options.js";

export function approveEvaluationCommand(
  approval: Approval,
  workspace: string,
) {
  if (approval.tool !== "run_command") {
    return false;
  }

  try {
    const command = JSON.parse(approval.description);

    return (
      typeof command.command === "string" &&
      Array.isArray(command.args) &&
      command.args.every((arg: unknown) => typeof arg === "string") &&
      typeof command.cwd === "string" &&
      path.isAbsolute(command.cwd) &&
      inside(workspace, command.cwd)
    );
  } catch {
    return false;
  }
}

function writeJson(file: string, value: unknown, key: string) {
  writeFileSync(
    file + ".tmp",
    redactJson(JSON.stringify(value, null, 2), [key]),
    {
      mode: 0o600,
    },
  );
  renameSync(file + ".tmp", file);
}

/** One fresh trial, with production tools and persistence. No benchmark grading here. */
export async function runEvaluation(
  rawOptions: unknown,
  dependencies: {
    provider?: ModelProvider;
    log?: Logger;
    signal?: AbortSignal;
  } = {},
) {
  const options = evaluationOptionsSchema.parse(rawOptions);
  const workspace = await realpath(options.workspace);
  mkdirSync(options.outputDir, { recursive: true });
  const outputDir = await realpath(options.outputDir);
  if (inside(workspace, outputDir) || inside(outputDir, workspace)) {
    throw new Error(
      "Evaluation workspace and output directories must be separate.",
    );
  }

  // This is an accidental-host-execution guard, not proof of sandbox security.
  if (
    options.allowWorkspaceCommands &&
    (process.platform !== "linux" || !existsSync("/.dockerenv"))
  ) {
    throw new Error(
      "Automatic command approvals require an explicit Docker trial.",
    );
  }

  const dataDir = path.join(outputDir, "data");
  mkdirSync(dataDir); // Refuse reuse so trials cannot inherit prior state.
  const config = new Config(dataDir);
  config.settings.maxSteps = options.maxSteps;
  if (!dependencies.provider && !config.apiKey) {
    throw new Error("Set CODEATELIER_API_KEY before running an evaluation.");
  }

  const log =
    dependencies.log ??
    createLogger(dataDir, config.settings.logLevel, () => [config.apiKey]);
  const store = new Store(path.join(dataDir, "history.sqlite"));
  const session = store.create(workspace, "Coding evaluation");
  const startedAt = new Date().toISOString();
  let stopReason: string | undefined;
  let approvalsAllowed = 0;
  let approvalsDenied = 0;
  const checkpoint = () => {
    writeJson(path.join(outputDir, "usage.json"), meter.usage, config.apiKey);
  };

  const meter = new MeteredProvider(
    dependencies.provider ??
      new ResponsesProvider(config.settings, config.apiKey),
    options,
    checkpoint,
  );
  const engine = new Engine(store, config, log, () => meter);
  const decideApprovals = () => {
    // Decide one at a time: deciding emits another change event synchronously.
    const approval = engine.approvals.list(session.id)[0];
    if (!approval) {
      return;
    }

    const allowed =
      options.allowWorkspaceCommands &&
      approveEvaluationCommand(approval, workspace);
    if (allowed) {
      approvalsAllowed++;
    } else {
      approvalsDenied++;
    }

    log.info({
      module: "evaluation",
      event: "evaluation.approval",
      tool: approval.tool,
      allowed,
    });
    engine.approvals.decide(approval.id, allowed ? "once" : "deny");
  };

  engine.events.on("change", decideApprovals);
  const abort = () => {
    stopReason = "cancelled";
    if (engine.active) {
      engine.cancel(engine.active.task.id);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    dependencies.signal?.throwIfAborted();
    const task = engine.start(session.id, options.prompt);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      stopReason = "timeout";
      engine.cancel(task.id);
    }, options.timeoutMs);
    await engine.active?.done;
    const result = store.task(task.id)!;
    const report = {
      schemaVersion: 1,
      agent: "CodeAtelier",
      model: config.settings.model,
      platform: process.platform,
      startedAt,
      finishedAt: new Date().toISOString(),
      task: result,
      stopReason: stopReason ?? meter.stopReason ?? result.status,
      // Agent completion is not a verifier reward or a claim of task correctness.
      verification: "external",
      limits: {
        maxTotalTokens: options.maxTotalTokens,
        maxModelCalls: options.maxModelCalls,
        maxSteps: options.maxSteps,
        timeoutMs: options.timeoutMs,
      },
      approvals: { allowed: approvalsAllowed, denied: approvalsDenied },
      usage: meter.usage,
      modelTimings: meter.timings,
    };
    writeJson(path.join(outputDir, "report.json"), report, config.apiKey);
    writeJson(
      path.join(outputDir, "events.json"),
      store.events(session.id),
      config.apiKey,
    );
    checkpoint();

    return report;
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", abort);
    await engine.close();
    store.close();
  }
}

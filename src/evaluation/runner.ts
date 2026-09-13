/**
 * 用生产 Engine 执行一次手动评测，保存任务报告、事件和持续更新的模型用量。
 * 命令行入口传入工作区、提示和预算，结果写入 report.json、events.json 和 usage.json。
 *
 * 1. approveEvaluationCommand 检查命令审批请求；writeJson 脱敏后通过临时文件保存记录。
 * 2. runEvaluation 检查工作区和输出目录互不包含，并新建 data 目录，避免带入上次任务状态。
 * 3. 创建 Config、Store、MeteredProvider 和 Engine，接好审批及取消回调。
 * 4. 等待任务完成或超时，导出状态、用量、耗时和审批次数，最后关闭引擎和数据库。
 *
 * 只有显式满足 Docker 条件才启用自动命令审批，这项检查本身不提供操作系统隔离。
 * 报告中的 verification 固定为 external，补丁是否正确由后续评分脚本判断。
 */

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

/** 用生产工具和独立数据库运行一次评测；补丁评分由外部脚本完成。 */
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

  // 这项检查用于防止误在宿主机执行，并不能证明容器已经安全隔离。
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
  const engine = new Engine(store, config, log, (selected, purpose) =>
    purpose === "auxiliary"
      ? meter.forProvider(
          dependencies.provider ??
            new ResponsesProvider(selected, config.apiKey),
        )
      : meter,
  );
  const decideApprovals = () => {
    // 每次只处理一项，因为 decide 会同步触发下一次 change 通知。
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
      // agent 结束不代表修复正确，评分仍由外部验证器完成。
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

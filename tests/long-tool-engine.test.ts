/**
 * 驱动真实宿主 Engine/进程链路验证长工具复查，不调用真实模型或 Evaluation。
 * 1. 只缩短五分钟复查计时器，命令和审批、SQLite 历史及 trace 使用生产实现。
 * 2. 审批期间不请求复查；输出截断后仍将最新尾部送到独立主模型请求。
 * 3. continue 保持同一进程，stop 等待清理并返回工具失败，主对话可以继续完成。
 * 4. 验证 usage/replay/trace 关联 callId，不把最新输出写入 trace；finally 关闭 Engine/Store。
 */
import { expect, it, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { TOOL_REVIEW_INTERVAL_MS } from "../src/tools/long-tool-monitor.js";
import { temp, waitForApproval } from "./fixtures/helpers.js";

it("reviews only executing commands and resumes the main conversation after stopping one call", async () => {
  const originalInterval = globalThis.setInterval;
  const interval = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation(((
      callback: (...args: any[]) => void,
      milliseconds?: number,
      ...args: any[]
    ) =>
      originalInterval(
        callback,
        milliseconds === TOOL_REVIEW_INTERVAL_MS ? 50 : milliseconds,
        ...args,
      )) as typeof setInterval);
  const config = new Config(await temp());
  config.settings.outputChars = 1000;
  config.settings.maxSteps = 2;
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(await temp(), "long command");
  let mainCalls = 0;
  let reviews = 0;
  let progressingReviews = 0;
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input, instructions, tools) {
      if (instructions.startsWith("Review a still-running tool.")) {
        reviews++;
        expect(tools).toEqual([]);
        const status = JSON.parse(input[0].content);
        expect(status.callId).toBe("long-command");
        if (status.latestOutput.includes("MONITOR_READY")) {
          progressingReviews++;
          expect(status.outputChars).toBeGreaterThan(
            config.settings.outputChars,
          );
        }

        return {
          output: [],
          text: JSON.stringify({
            action: progressingReviews >= 2 ? "stop" : "continue",
            reason: "测试进程无需持续运行",
          }),
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
      }

      if (++mainCalls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "long-command",
              name: "run_command",
              arguments: JSON.stringify({
                command:
                  "node -e \"console.log('old'.repeat(2000));console.log('MONITOR_READY');setInterval(()=>{},1000)\"",
              }),
            },
          ],
          text: "",
        };
      }

      const result = input.find(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "long-command",
      );
      expect(result.output).toContain("模型中断");

      return {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        text: "done",
      };
    },
  }));
  try {
    const task = engine.start(session.id, "检查输出然后结束常驻命令");
    const approval = await waitForApproval(engine, task.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reviews).toBe(0);
    engine.approvals.decide(approval.id, "once");
    await engine.active?.done;
    expect(store.task(task.id)?.status).toBe("completed");
    expect(mainCalls).toBe(2);
    expect(progressingReviews).toBe(2);
    const events = store.events(session.id);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.type === "model_usage" && event.data.purpose === "tool_review",
      ),
    ).toBe(true);
    expect(
      store
        .replayCase(task.id)
        ?.capture?.modelExchanges.some(
          (exchange) => exchange.purpose === "tool_review",
        ),
    ).toBe(true);
    const trace = JSON.parse((await engine.savedTrace(task))!);
    expect(trace.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "llm.request",
          args: expect.objectContaining({
            purpose: "tool_review",
            callId: "long-command",
          }),
        }),
      ]),
    );
  } finally {
    interval.mockRestore();
    await engine.close();
    store.close();
  }
}, 30000);

/**
 * 验证自动 Skill 目录贯穿 Engine、ToolRunner、Runtime IPC、模型上下文和任务历史。
 * 1. launcher 创建正式服务代码的 Node stdio harness，等待退出；不伪称固定账户安装态 Sandbox 验收。
 * 2. 每个用例隔离 workspace、宿主 home 和 Store，以脚本模型观察摘要先行、按需正文及失败 DAG 后继。
 * 3. 在第二任务改变文件，验证无需服务重启即可刷新；断言历史/replay 保存结果、trace 不含正文和元信息。
 * 所有模型、审批均离线，未调用真实 API、执行 Skill 脚本或运行 Evaluation。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
import { temp } from "./fixtures/helpers.js";

function launcher(): AgentRuntimeLauncher {
  return {
    async launch(input) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("tests/fixtures/agent-runtime-service-child.ts"),
        ],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CODEATELIER_TEST_RUNTIME_DESCRIPTOR: JSON.stringify({
              identity: input.identity,
              nonce: input.nonce,
            }),
          },
        },
      );
      child.stderr.resume();
      const exited = new Promise<"clean" | "orphaned">((resolve) => {
        child.once("exit", (code) =>
          resolve(code === 0 ? "clean" : "orphaned"),
        );
      });

      return {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        close: async () => {
          child.stdin.end();
          const timer = setTimeout(() => child.kill(), 5000);
          try {
            return await exited;
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },
  };
}

it.each([false, true])(
  "loads skills lazily through the backend, persists results and refreshes next task with Runtime=%s",
  async (runtime) => {
    const root = await temp();
    const directory = await temp();
    const home = await temp();
    const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
    const skillDirectory = path.join(home, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    const file = path.join(skillDirectory, "SKILL.md");
    const save = (version: string) =>
      writeFile(
        file,
        `---\nname: review\ndescription: private-summary-${version}\nallowed-tools: [run_command]\n---\nprivate-body-${version}\n`,
      );
    await save("one");
    const config = new Config(directory);
    config.sandbox.enabled = runtime;
    const store = new Store(path.join(directory, "db"));
    const session = store.create(root, "Skills integration");
    let version = "one";
    let calls = 0;
    const call = (id: string, request: unknown, dependsOn: string[] = []) => ({
      type: "function_call" as const,
      call_id: `${version}-${id}`,
      name: "skill",
      arguments: JSON.stringify({
        execution: { id, dependsOn },
        arguments: { request },
      }),
    });
    const provider: ModelProvider = {
      async getCapabilities() {
        return {
          limits: {
            max_context_window_tokens: 128000,
            max_output_tokens: 1024,
          },
        };
      },
      async run(input, instructions, tools) {
        expect(tools.some((tool) => tool.name === "skill")).toBe(true);
        expect(instructions).toContain(`private-summary-${version}`);
        expect(instructions).not.toContain(`private-body-${version}`);
        expect(instructions).toContain("not permission grants");
        calls += 1;
        if (calls === 1) {
          expect(JSON.stringify(input)).not.toContain(
            `private-body-${version}`,
          );

          return {
            text: "",
            output: [
              call("list", { action: "list" }),
              call("load", { action: "load", name: "review" }, ["list"]),
            ],
          };
        }

        expect(JSON.stringify(input)).toContain(`private-body-${version}`);
        expect(JSON.stringify(input)).toContain("broker-skill");
        if (calls === 2) {
          return {
            text: "",
            output: [
              call("missing", { action: "load", name: "missing" }),
              call("blocked", { action: "list" }, ["missing"]),
            ],
          };
        }

        const blocked = input.find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === `${version}-blocked`,
        );
        expect(blocked).toBeDefined();
        expect(JSON.parse(blocked.output)).toMatchObject({
          code: "dependency_failed",
          failedDependency: "missing",
        });

        return { text: "Skill task done", output: [] };
      },
    };
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => provider,
      runtime ? launcher() : undefined,
    );
    const approval = vi
      .spyOn(engine.approvals, "request")
      .mockRejectedValue(
        new Error("Skill must not request command permissions"),
      );
    try {
      for (const next of ["one", "two"]) {
        version = next;
        calls = 0;
        await save(version);
        const task = engine.start(session.id, "Use the review skill");
        await engine.active?.done;
        expect(store.task(task.id)?.status).toBe("completed");
        expect(calls).toBe(3);
        const replay = store.replayCase(task.id);
        const loaded = replay?.capture?.tools.find(
          (tool) => tool.callId === `${version}-load`,
        )?.result;
        expect(loaded).toMatchObject({
          content: `private-body-${version}`,
          skill: { directory: skillDirectory, source: "user/.agents/skills" },
          execution: { kind: "broker-skill", mode: "host-process" },
        });
        // Runtime 的未执行节点没有 toolStart/replay 条目；验证持久化状态及模型收到的阻断反馈。
        expect(store.events(session.id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "tool_state",
              data: expect.objectContaining({
                callId: `${version}-blocked`,
                state: "blocked",
              }),
            }),
          ]),
        );
        expect(JSON.stringify(store.events(session.id))).toContain(
          `private-body-${version}`,
        );
        const trace = (await engine.savedTrace(task))!;
        expect(trace).toContain("skills.discover");
        expect(trace).toContain("skills.load");
        expect(trace).not.toContain("private-body-");
        expect(trace).not.toContain("private-summary-");
        if (runtime) {
          expect(trace).toContain("broker-host-wait");
        }
      }

      expect(approval).not.toHaveBeenCalled();
    } finally {
      await engine.close();
      store.close();
      homeMock.mockRestore();
    }
  },
);

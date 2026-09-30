/*
 * 用双向内存 IPC 和 Broker session 验证已认证子模型路由、工具白名单及租约账本。
 *
 * 1. 在握手后的同一 task/instance 下验证无租约、冒用主任务身份及写工具声明均在模型调用前拒绝。
 * 2. 已登记子请求与租约才能代理三个只读文件工具及有界 ask_main；重复释放、断连清理不得提前借出额度。
 * 3. 校验协议只允许有界问题而不允许任意写入；本夹具不证明 Windows transport/OS 身份。
 */

import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { subagentToolDefinitions } from "../src/agent/subagent-question-contract.js";
import { connectAgentRuntime } from "../src/sandbox/agent-runtime-connection.js";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

it("rejects forged subagent requests and retains leases until the instance is cleaned", async () => {
  const runtimeToBroker = new PassThrough();
  const brokerToRuntime = new PassThrough();
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
  const nonce = "0123456789abcdef0123456789abcdef";
  let modelCalls = 0;
  let releases = 0;
  let questions = 0;
  const started = new Set<string>();
  const gateway = new RuntimeBrokerGateway(
    {
      authorize: (candidate) => candidate === identity,
      approveCommand: async () => ({ approved: false }),
      modelProvider: () => ({
        model: "mock-model",
        provider: {
          async run() {
            modelCalls++;

            return { output: [], text: "read-only result" };
          },
        },
      }),
    },
    new TraceRecorder(),
  );
  const broker = new RuntimeIpcBrokerSession(
    { input: runtimeToBroker, output: brokerToRuntime },
    identity,
    nonce,
    gateway,
    {
      requestApproval: async () => ({ approved: false }),
      executeGitPush: async () => ({
        output: "",
        exitCode: 1,
        truncated: false,
      }),
      prepareCapabilityCommand: async () => async () => {
        throw new Error("not available");
      },
      applyMemory: async () => {
        throw new Error("not available");
      },
      appendSessionEvent: async () => undefined,
      saveContext: async () => undefined,
      readContext: async () => [],
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: async () => undefined,
      runtimeCompleted: async () => undefined,
      subagentStore: async (candidate, request) => {
        expect(candidate).toBe(identity);
        if (request.action === "request_start") {
          started.add(request.requestId);
        }

        if (request.action === "question") {
          questions++;
        }

        return { saved: true };
      },
      authorizeSubagentModel: async (candidate, id, requestId) => {
        if (
          candidate !== identity ||
          id !== "review" ||
          !started.has(requestId)
        ) {
          throw new Error("not registered");
        }
      },
      acquireSubagentLease: async (candidate, id) => {
        if (candidate !== identity || id !== "review") {
          throw new Error("not registered");
        }

        return () => {
          releases++;
        };
      },
    },
  );
  const peer = await connectAgentRuntime(
    { input: brokerToRuntime, output: runtimeToBroker },
    identity,
    nonce,
    AbortSignal.timeout(2_000),
  );
  const signal = AbortSignal.timeout(2_000);
  const modelBody = {
    purpose: "subagent",
    subagentId: "review",
    subagentRequestId: "model-1",
    input: [],
    instructions: "read only",
    tools: subagentToolDefinitions,
  };

  const rejectedByBroker = async (
    request: Promise<unknown>,
    reason = /model_run.*(授权|not registered|身份)/,
  ) => {
    await expect(request).rejects.toMatchObject({
      code: "RUNTIME_REQUEST_FAILED",
      message: expect.stringMatching(reason),
    });
  };

  try {
    await rejectedByBroker(peer.request("model_run", modelBody, signal));
    const lease = (await peer.request(
      "subagent_lease_acquire",
      { subagentId: "review" },
      signal,
    )) as { leaseId: string };
    await rejectedByBroker(
      peer.request(
        "model_run",
        { ...modelBody, tools: [{ type: "function", name: "edit_files" }] },
        signal,
      ),
    );
    await rejectedByBroker(
      peer.request(
        "model_run",
        { ...modelBody, subagentRequestId: "other" },
        signal,
      ),
    );
    await rejectedByBroker(
      peer.request("model_run", { ...modelBody, purpose: "task" }, signal),
    );
    await expect(
      peer.request(
        "subagent_store",
        { action: "edit_files", path: "data.txt" },
        signal,
      ),
    ).rejects.toMatchObject({
      code: "SANDBOX_RUNTIME_IPC",
      message: expect.stringMatching(/subagent_store.*body/),
    });
    await expect(
      peer.request(
        "subagent_store",
        {
          action: "question",
          subagentId: "review",
          requestId: "too-long",
          question: "x".repeat(1_001),
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_RUNTIME_IPC" });
    expect(questions).toBe(0);
    await expect(
      peer.request(
        "subagent_store",
        {
          action: "question",
          subagentId: "review",
          requestId: "q-1",
          question: "Which file?",
        },
        signal,
      ),
    ).resolves.toMatchObject({ saved: true });
    expect(questions).toBe(1);
    expect(modelCalls).toBe(0);
    expect(releases).toBe(0);

    await peer.request(
      "subagent_store",
      {
        action: "request_start",
        subagentId: "review",
        requestId: "model-1",
        kind: "model",
      },
      signal,
    );
    await expect(
      peer.request("model_run", modelBody, signal),
    ).resolves.toMatchObject({ text: "read-only result" });
    expect(modelCalls).toBe(1);
    await peer.request(
      "subagent_lease_release",
      { leaseId: lease.leaseId },
      signal,
    );
    await rejectedByBroker(
      peer.request(
        "subagent_lease_release",
        { leaseId: lease.leaseId },
        signal,
      ),
      /subagent_lease_release.*租约无效或已释放/,
    );
    await peer.request(
      "subagent_lease_acquire",
      { subagentId: "review" },
      signal,
    );
    expect(releases).toBe(1);
    peer.end();
    broker.peer.end();
    expect(releases).toBe(1);
    broker.releaseSubagentLeases();
    expect(releases).toBe(2);
  } finally {
    peer.end();
    broker.peer.end();
    broker.releaseSubagentLeases();
  }
});

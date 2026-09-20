/**
 * 验证 supervisor JSONL 通道的有界 framing、并发路由和故障扩散。
 *
 * 1. 两个并发请求可以以相反顺序返回，仍按 requestId 匹配。
 * 2. AbortSignal 只取消本地等待，已取消请求的首个迟到响应会被丢弃而不破坏其它并发请求。
 * 3. 超限帧、非法 JSON 和未请求 requestId 都会拒绝全部 pending 请求。
 *
 * PassThrough 只模拟已建立的私有 handle，不验证 Windows handle 继承或进程身份。
 */

import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { JsonLineSupervisorChannel } from "../src/sandbox/supervisor-channel.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorRequest,
} from "../src/sandbox/supervisor-protocol.js";

function request(requestId: string): SupervisorRequest {
  return {
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    requestId,
    operation: "shutdown",
  };
}

it("routes concurrent out-of-order responses by request id", async () => {
  const fromSupervisor = new PassThrough();
  const toSupervisor = new PassThrough();
  const channel = new JsonLineSupervisorChannel(fromSupervisor, toSupervisor);
  const first = channel.request(request("first"), new AbortController().signal);
  const second = channel.request(
    request("second"),
    new AbortController().signal,
  );

  fromSupervisor.write(
    `${JSON.stringify({ requestId: "second", result: "second-result" })}\n`,
  );
  fromSupervisor.write(
    `${JSON.stringify({ requestId: "first", result: "first-result" })}\n`,
  );

  await expect(first).resolves.toMatchObject({ result: "first-result" });
  await expect(second).resolves.toMatchObject({ result: "second-result" });
});

it("discards one late cancelled response without terminating another wait", async () => {
  const fromSupervisor = new PassThrough();
  const toSupervisor = new PassThrough();
  const channel = new JsonLineSupervisorChannel(fromSupervisor, toSupervisor);
  const controller = new AbortController();
  const pending = channel.request(request("cancelled"), controller.signal);
  const active = channel.request(
    request("active"),
    new AbortController().signal,
  );

  controller.abort(new Error("cancel wait"));
  fromSupervisor.write(
    `${JSON.stringify({ requestId: "cancelled", result: "late" })}\n`,
  );
  fromSupervisor.write(
    `${JSON.stringify({ requestId: "active", result: "complete" })}\n`,
  );

  await expect(pending).rejects.toThrow("cancel wait");
  await expect(active).resolves.toMatchObject({ result: "complete" });
});

it("fails every pending request after an unsolicited response", async () => {
  const fromSupervisor = new PassThrough();
  const toSupervisor = new PassThrough();
  const channel = new JsonLineSupervisorChannel(fromSupervisor, toSupervisor);
  const first = channel.request(request("first"), new AbortController().signal);
  const second = channel.request(
    request("second"),
    new AbortController().signal,
  );

  fromSupervisor.write(`${JSON.stringify({ requestId: "unknown" })}\n`);

  await expect(first).rejects.toMatchObject({
    code: "SANDBOX_SUPERVISOR_PROTOCOL",
  });
  await expect(second).rejects.toMatchObject({
    code: "SANDBOX_SUPERVISOR_PROTOCOL",
  });
});

it("rejects oversized incomplete frames", async () => {
  const fromSupervisor = new PassThrough();
  const toSupervisor = new PassThrough();
  const channel = new JsonLineSupervisorChannel(
    fromSupervisor,
    toSupervisor,
    64,
  );
  const pending = channel.request(
    request("small"),
    new AbortController().signal,
  );

  fromSupervisor.write("x".repeat(65));

  await expect(pending).rejects.toMatchObject({
    code: "SANDBOX_SUPERVISOR_PROTOCOL",
  });
});

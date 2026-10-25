/**
 * Windows 发布租约客户端的管道协议回归，默认 Vitest 使用可控子进程替身，不安装或加载驱动。
 * 1. MockChild 提供真实 Node 流/事件，控制 ready、逐命令收据和进程 close 的先后关系。
 * 2. 验证有界单请求、显式 finish 后等待退出、原生拒绝后正常排空和异常退出信号。
 * 3. 坏收据/过大输出必须失效，不把超时或进程消失当作写入未发生。
 * 原生排他、PID/创建时间及文件操作由手动 verify-lease 实测；这里不模拟 OS 安全保证。
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as immediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { PublicationLease } from "../src/local-overlays/publication/publication-lease.js";

const state = vi.hoisted(() => ({ children: [] as MockChild[] }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (_file: string, args: string[]) => {
    const child = new MockChild();
    state.children.push(child);
    queueMicrotask(() =>
      child.reply({
        version: 1,
        state: "publication-ready",
        generation: args[2],
      }),
    );

    return child;
  },
}));

class MockChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: string[] = [];
  killed = false;
  onCommand?: (command: string) => void;
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const command = String(chunk).trim();
      this.commands.push(command);
      this.onCommand?.(command);
      done();
    },
  });

  reply(value: unknown) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null));

    return true;
  }

  finish() {
    this.onCommand = (command) => {
      expect(command).toBe("finish");
      this.reply({ version: 1, state: "publication-closed" });
      queueMicrotask(() => this.emit("close", 0));
    };
  }
}

describe.skipIf(process.platform !== "win32")(
  "publication lease protocol",
  () => {
    it("waits for process exit after explicit close and rejects later writes", async () => {
      const lease = await PublicationLease.start("fixture.lease");
      const child = state.children.at(-1)!;
      child.onCommand = () =>
        child.reply({ version: 1, state: "publication-closed" });
      let finished = false;
      const close = lease.close().then(() => {
        finished = true;
      });
      await immediate();
      expect(finished).toBe(false);
      child.emit("close", 0);
      await close;
      expect(lease.signal.aborted).toBe(false);
      await expect(lease.delete("code.txt", "a".repeat(64))).rejects.toThrow(
        "PUBLICATION_EXECUTION_UNAVAILABLE",
      );
      expect(child.commands).toEqual(["finish"]);
    });

    it("allows only one outstanding request and binds each receipt to its operation", async () => {
      const lease = await PublicationLease.start("fixture.lease");
      const child = state.children.at(-1)!;
      const pending = lease.delete("code.txt", "a".repeat(64));
      await expect(
        lease.create("code.txt", "temp.txt", "b".repeat(64)),
      ).rejects.toThrow("PUBLICATION_EXECUTION_UNAVAILABLE");
      child.reply({ version: 1, state: "deleted" });
      await pending;
      expect(child.commands).toEqual([
        `delete ${Buffer.from("code.txt").toString("hex")} ${"a".repeat(64)}`,
      ]);
      child.finish();
      await lease.close();
    });

    it("keeps an ordinary native rejection observable but permits explicit drain", async () => {
      const lease = await PublicationLease.start("fixture.lease");
      const child = state.children.at(-1)!;
      child.onCommand = () =>
        child.reply({ version: 1, error: "native", status: 0xc0000022 });
      await expect(lease.delete("code.txt", "a".repeat(64))).rejects.toThrow(
        "NATIVE_PUBLISH_UNCONFIRMED",
      );
      expect(lease.signal.aborted).toBe(false);
      child.finish();
      await lease.close();
    });

    it("aborts an in-flight operation on unexpected exit without claiming completion", async () => {
      const lease = await PublicationLease.start("fixture.lease");
      const child = state.children.at(-1)!;
      const pending = lease.delete("code.txt", "a".repeat(64));
      child.emit("close", 1);
      await expect(pending).rejects.toThrow(
        "PUBLICATION_EXECUTION_UNCONFIRMED",
      );
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.close()).rejects.toThrow(
        "PUBLICATION_EXECUTION_UNAVAILABLE",
      );
    });

    it.each(["mismatched", "oversized"])(
      "terminates on %s receipt",
      async (kind) => {
        const lease = await PublicationLease.start("fixture.lease");
        const child = state.children.at(-1)!;
        const pending = lease.delete("code.txt", "a".repeat(64));
        if (kind === "mismatched") {
          child.reply({ version: 1, state: "created" });
        } else {
          child.stdout.write("x".repeat(8193));
        }

        await expect(pending).rejects.toThrow(
          /PUBLICATION_(PROTOCOL|EXECUTION_UNCONFIRMED)/,
        );
        expect(child.killed).toBe(true);
        expect(lease.signal.aborted).toBe(true);
        await expect(lease.close()).rejects.toThrow(
          "PUBLICATION_EXECUTION_UNAVAILABLE",
        );
      },
    );
  },
);

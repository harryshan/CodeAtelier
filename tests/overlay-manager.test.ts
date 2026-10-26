/**
 * 验证宿主 OverlayManager 的协议、取消和失败关闭边界，不模拟文件系统正确性。
 * 1. 使用管道夹具控制 ready/stopped/close，检查只接受完整收据且同一请求去重。
 * 2. helper 异常退出后不得在本进程重挂载；取消必须等待停止，关闭必须证明 stopped + exit 0。
 * 3. 校验托管 UNC 命名空间不能将子目录或另一数据目录误认作同一个挂载。
 * 4. Git PoC 显式选择及新旧分段 metrics 收据不能改变 live 挂载协议或终止普通挂载。
 * 5. Local 策略须有明确能力收据；重复 ID 不能换来源、控制目录或策略。
 * 6. 冻结导出必须收到 frozen 后开始，持有 helper 到导出完成；租约丢失不得返回成功结果。
 * 7. 发布确认须等待匹配批次与代次的收据，错误收据及租约丢失均拒绝。
 * 8. 冻结取消/关闭先中止回调并等待排空；不在回调仍运行时释放 helper 或报告关闭成功。
 * 9. 显式回收等待完整计数收据，排斥并发控制请求，作用域过期和损坏/丢失收据拒绝。
 * 10. 新观察周期绑定请求/旧代次/seal；不接受另一请求的收据，且与其它冻结控制请求互斥。
 * 11. 根 ACL 恢复只接受 local-security 收据，不接受普通 Local/旧 helper，也不能创建新卷。
 * 原生文件、Git 和受限 token 语义由手动 verify-winfsp-overlay 独立验证。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { beforeEach, expect, it, vi } from "vitest";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  overlayWorkspaceId,
} from "../src/worktrees/overlay.js";
import { temp } from "./fixtures/helpers.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

class Helper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor(clean = true) {
    super();
    this.stdin.on("finish", () => {
      if (this.killed) {
        return;
      }

      if (clean) {
        this.stdout.write('{"version":1,"state":"stopped"}\n');
      }

      this.emit("close", clean ? 0 : 1);
    });
  }

  kill() {
    this.killed = true;
    this.emit("close", 1);
  }

  ready() {
    this.stdout.write('{"version":1,"state":"ready"}\n');
  }
}

beforeEach(() => spawn.mockReset());

async function localFixture() {
  const f = await fixture();
  const starting = f.manager.start(
    f.id,
    f.directory,
    f.directory,
    f.workspace,
    true,
    f.controller.signal,
    { kind: "local" },
  );
  f.helper.stdout.write('{"version":1,"state":"ready","mode":"local"}\n');
  await starting;

  return f;
}

it("collects only within the frozen scope and serializes control requests", async () => {
  const f = await localFixture();
  let savedCollect: (() => Promise<unknown>) | undefined;
  const receipt = {
    version: 1,
    state: "collected",
    mode: "local",
    nodes: 2,
    examined: 6,
    removed: 3,
    bytes: 8192,
    retained: 1,
  };
  const pending = f.manager.withFrozen(
    f.id,
    async (verify, _acknowledge, _signal, collect) => {
      savedCollect = collect;
      const first = collect();
      await expect(collect()).rejects.toThrow("unavailable");
      await expect(verify()).rejects.toThrow("unavailable");
      expect(f.helper.stdin.read()?.toString()).toBe("collect\n");
      f.helper.stdout.write(JSON.stringify(receipt) + "\n");

      return first;
    },
  );
  expect(f.helper.stdin.read()?.toString()).toBe("freeze\n");
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  expect(await pending).toEqual(receipt);
  expect(savedCollect).toBeDefined();
  await expect(savedCollect!()).rejects.toThrow("ended");
  await f.manager.close();
});

it.each(["malformed", "lost"])(
  "refuses %s collection receipts",
  async (failure) => {
    const f = await localFixture();
    const pending = f.manager.withFrozen(
      f.id,
      async (_verify, _acknowledge, _signal, collect) => {
        const collecting = collect();
        if (failure === "lost") {
          f.helper.kill();
        } else {
          f.helper.stdout.write(
            '{"version":1,"state":"collected","mode":"local","removed":-1}\n',
          );
        }

        return collecting;
      },
    );
    const rejected = expect(pending).rejects.toThrow();
    f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
    await rejected;
    if (failure === "lost") {
      await expect(f.manager.close()).rejects.toThrow();
    } else {
      // Invalid collection data does not invalidate a separate clean-stop receipt.
      await f.manager.close();
    }
  },
);

it("waits for frozen receipt and retains the helper until export finishes", async () => {
  const f = await localFixture();
  let entered = false;
  let finish!: () => void;
  const pending = f.manager.withFrozen(f.id, async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });

    return "sealed result";
  });
  expect(entered).toBe(false);
  expect(f.helper.stdin.read()?.toString()).toBe("freeze\n");
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(f.helper.stdin.writableEnded).toBe(false);
  await expect(f.manager.metrics(f.id)).rejects.toThrow("unavailable");
  await expect(f.manager.withFrozen(f.id, async () => null)).rejects.toThrow(
    "cannot be frozen",
  );
  finish();
  expect(await pending).toBe("sealed result");
  expect(f.helper.stdin.writableEnded).toBe(true);
  await f.manager.close();
});

it.each([true, false])(
  "binds the epoch transition receipt and excludes concurrent controls: %s",
  async (matching) => {
    const f = await localFixture();
    const request = { requestId: randomUUID(), seal: randomUUID(), epoch: 3 };
    const pending = f.manager.withFrozen(
      f.id,
      async (verify, _acknowledge, _signal, collect, nextEpoch) => {
        const advancing = nextEpoch(request);
        await expect(collect()).rejects.toThrow("unavailable");
        await expect(verify()).rejects.toThrow("unavailable");
        await expect(nextEpoch(request)).rejects.toThrow("unavailable");
        expect(f.helper.stdin.read()?.toString()).toBe(
          `next-epoch ${request.requestId} 3 ${request.seal}\n`,
        );
        f.helper.stdout.write(
          JSON.stringify({
            version: 1,
            mode: "local",
            state: "epoch-advanced",
            ...request,
            requestId: matching ? request.requestId : randomUUID(),
            epoch: 4,
          }) + "\n",
        );
        await advancing;

        return "advanced";
      },
    );
    const result = matching
      ? expect(pending).resolves.toBe("advanced")
      : expect(pending).rejects.toThrow();
    f.helper.stdin.read();
    f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
    await result;
    await f.manager.close();
  },
);

it("does not return export results when the helper lease is lost", async () => {
  const f = await localFixture();
  const pending = f.manager.withFrozen(f.id, async () => {
    f.helper.kill();

    return "untrusted result";
  });
  const rejected = expect(pending).rejects.toThrow();
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  await rejected;
  await expect(f.manager.close()).rejects.toThrow("清理未全部完成");
});

it("cancels and drains a frozen callback before reporting lost lease cleanup", async () => {
  const f = await localFixture();
  let received: AbortSignal | undefined;
  let entered = false;
  let settled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.manager.withFrozen(
    f.id,
    async (_verify, _acknowledge, signal?: AbortSignal) => {
      received = signal;
      entered = true;
      await gate;
      signal?.throwIfAborted();
    },
  );
  const completion = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    f.helper.kill();
    await vi.waitFor(() => expect(received?.aborted).toBe(true));
    expect(settled).toBe(false);
  } finally {
    release();
    await completion;
    await expect(f.manager.close()).rejects.toThrow();
  }
});

it("waits for native read verification before releasing a frozen batch", async () => {
  const f = await localFixture();
  let finished = false;
  const pending = f.manager.withFrozen(f.id, async (verifyReads) => {
    await verifyReads();
    finished = true;

    return "verified batch";
  });
  f.helper.stdin.read();
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  await vi.waitFor(() => {
    expect(f.helper.stdin.read()?.toString()).toBe("check-reads\n");
  });
  expect(finished).toBe(false);
  expect(f.helper.stdin.writableEnded).toBe(false);
  f.helper.stdout.write(
    '{"version":1,"state":"reads-checked","mode":"local"}\n',
  );
  expect(await pending).toBe("verified batch");
  await f.manager.close();
});

it.each(["caller", "manager"])(
  "drains a frozen callback before shutdown requested by %s",
  async (method) => {
    const f = await localFixture();
    const cancellation = new AbortController();
    let received: AbortSignal | undefined;
    let finished = false;
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.manager.withFrozen(
      f.id,
      async (_verify, _acknowledge, signal) => {
        received = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        await cleanup;
        signal.throwIfAborted();
      },
      cancellation.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    const complete = pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
    await vi.waitFor(() => expect(received).toBeDefined());
    let closing: Promise<void> | undefined;
    if (method === "caller") {
      cancellation.abort(new Error("User cancellation"));
    } else {
      closing = f.manager.close();
    }

    try {
      await vi.waitFor(() => expect(received?.aborted).toBe(true));
      expect(finished).toBe(false);
      expect(f.helper.stdin.writableEnded).toBe(false);
    } finally {
      release();
      await rejected;
      await complete;
      await closing;
      await f.manager.close();
    }

    expect(f.helper.stdin.writableEnded).toBe(true);
  },
);

it("cleans up after export failure and never freezes legacy mounts", async () => {
  const f = await localFixture();
  const pending = f.manager.withFrozen(f.id, async () => {
    throw new Error("export rejected");
  });
  const rejected = expect(pending).rejects.toThrow("export rejected");
  f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
  await rejected;
  await f.manager.close();

  const legacy = await fixture();
  const starting = legacy.start();
  legacy.helper.ready();
  await starting;
  await expect(
    legacy.manager.withFrozen(legacy.id, async () => null),
  ).rejects.toThrow("cannot be frozen");
  expect(legacy.helper.stdin.read()).toBeNull();
  await legacy.manager.close();
});

it.each([true, false])(
  "requires a matching publication acknowledgement receipt: %s",
  async (matching) => {
    const f = await localFixture();
    const batchId = randomUUID();
    const seal = randomUUID();
    let entered = false;
    const pending = f.manager.withFrozen(f.id, async (_verify, acknowledge) => {
      entered = true;
      await acknowledge({ batchId, seal, epoch: 2, paths: ["\\src\\file.ts"] });

      return "acknowledged";
    });
    const result = matching
      ? expect(pending).resolves.toBe("acknowledged")
      : expect(pending).rejects.toThrow();
    f.helper.stdin.read();
    f.helper.stdout.write('{"version":1,"state":"frozen","mode":"local"}\n');
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(f.helper.stdin.read()?.toString()).toContain(
      `acknowledge ${batchId} 2 `,
    );
    expect(f.helper.stdin.writableEnded).toBe(false);
    f.helper.stdout.write(
      JSON.stringify({
        version: 1,
        state: "acknowledged",
        mode: "local",
        batchId: matching ? batchId : randomUUID(),
        seal,
        epoch: 3,
      }) + "\n",
    );
    await result;
    // This protocol fixture still supplies stopped + exit 0 after rejection.
    // A rejected acknowledgement must not prevent confirmed resource cleanup.
    await f.manager.close();
  },
);

async function fixture(helper = new Helper()) {
  spawn.mockImplementation(() => helper);
  const directory = await temp();
  const manager = new OverlayManager(
    directory,
    pino({ enabled: false }),
    "fixed-helper",
  );
  const id = randomUUID();
  const workspace = overlayWorkspace(overlayNamespace(directory), id);
  const controller = new AbortController();
  const start = () =>
    manager.start(id, directory, directory, workspace, true, controller.signal);

  return { helper, manager, controller, start, id, workspace, directory };
}

it("waits for ready, deduplicates the mount and proves clean shutdown", async () => {
  const f = await fixture();
  let ready = false;
  const first = f.start().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  const duplicate = f.start();
  f.helper.ready();
  await Promise.all([first, duplicate]);
  expect(spawn).toHaveBeenCalledTimes(1);
  await f.manager.close();
  await f.manager.close();
  expect(f.helper.stdin.writableEnded).toBe(true);
  expect(f.helper.killed).toBe(false);
});

it("blocks reuse after an unexpected exit without creating another helper", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  f.helper.kill();
  await expect(f.start()).rejects.toThrow("失去挂载");
  await expect(f.manager.close()).rejects.toThrow("清理未全部完成");
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("cancels a pending mount and drains its stdin before reporting failure", async () => {
  const f = await fixture();
  const starting = f.start();
  f.controller.abort();
  await expect(starting).rejects.toThrow();
  expect(f.helper.stdin.writableEnded).toBe(true);
  await f.manager.close();
});

it("rejects incompatible readiness and an exit without a clean receipt", async () => {
  const f = await fixture(new Helper(false));
  const starting = f.start();
  f.helper.stdout.write('{"version":2,"state":"ready"}\n');
  await expect(starting).rejects.toThrow();
  await expect(f.manager.close()).rejects.toThrow("清理未全部完成");
});

it("recognizes only its exact managed UNC share roots", () => {
  const namespace = overlayNamespace("fixture-data");
  const id = randomUUID();
  const workspace = overlayWorkspace(namespace, id);
  expect(overlayWorkspaceId(namespace, workspace)).toBe(id);
  expect(
    overlayWorkspaceId(overlayNamespace("another-data"), workspace),
  ).toBeUndefined();
  expect(() => overlayWorkspaceId(namespace, `${workspace}child`)).toThrow(
    "子目录",
  );
});

it("unmounts a failed creation without stopping another ready workspace", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  const peer = new Helper();
  spawn.mockReturnValueOnce(peer);
  const id = randomUUID();
  const mounting = f.manager.start(
    id,
    "source",
    "control",
    overlayWorkspace("peer", id),
    true,
    f.controller.signal,
  );
  peer.ready();
  await mounting;
  await f.manager.stop(id);
  expect(peer.stdin.writableEnded).toBe(true);
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

it("reads complete Git PoC metrics without treating them as a stop receipt", async () => {
  const f = await fixture();
  const starting = f.manager.start(
    f.id,
    f.directory,
    f.directory,
    f.workspace,
    true,
    f.controller.signal,
    {
      executable: "fixed-git",
      directory: "fixed-common",
      tree: "a".repeat(40),
    },
  );
  f.helper.ready();
  await starting;
  const pending = f.manager.metrics(f.id);
  await expect(f.manager.metrics(f.id)).rejects.toThrow("already pending");
  const receipt = {
    version: 1,
    state: "metrics",
    treeReads: 0,
    infoReads: 0,
    blobReads: 0,
    blobBytes: 0,
    lowerOpens: 0,
    lowerEnumerations: 0,
  };
  const json = JSON.stringify(receipt);
  f.helper.stdout.write(json.slice(0, 20));
  f.helper.stdout.write(json.slice(20) + "\n");
  expect(await pending).toEqual(receipt);
  const profiled = {
    ...receipt,
    objectMicros: 120,
    sqlPrepareMicros: 4,
    sqlReadMicros: 6,
    sqlWriteMicros: 12,
    sqlExecMicros: 18,
    sqlReads: 3,
    sqlWrites: 2,
    accessCleanups: 1,
    lowerImportCommits: 2,
  };
  const next = f.manager.metrics(f.id);
  f.helper.stdout.write(JSON.stringify(profiled) + "\n");
  expect(await next).toEqual(profiled);
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

it("rejects metrics on live overlays without sending an unsupported native command", async () => {
  const f = await fixture();
  const starting = f.start();
  f.helper.ready();
  await starting;
  await expect(f.manager.metrics(f.id)).rejects.toThrow("unavailable");
  expect(f.helper.stdin.read()).toBeNull();
  expect(f.helper.stdin.writableEnded).toBe(false);
  await f.manager.close();
});

it("requires a Local policy receipt instead of accepting a legacy helper", async () => {
  const f = await fixture();
  const starting = f.manager.start(
    f.id,
    f.directory,
    f.directory,
    f.workspace,
    true,
    f.controller.signal,
    { kind: "local" },
  );
  f.helper.ready();
  await expect(starting).rejects.toThrow("策略");
  expect(f.helper.stdin.writableEnded).toBe(true);
  await f.manager.close();
});

it.each(["local-security", "local", undefined])(
  "requires the exact ACL recovery receipt: %s",
  async (mode) => {
    const f = await fixture();
    const starting = f.manager.start(
      f.id,
      f.directory,
      f.directory,
      f.workspace,
      false,
      f.controller.signal,
      { kind: "local-security" },
    );
    f.helper.stdout.write(
      JSON.stringify({ version: 1, state: "ready", mode }) + "\n",
    );
    if (mode === "local-security") {
      await starting;
      expect(spawn.mock.calls[0][1][0]).toBe("restore-local-security");
    } else {
      await expect(starting).rejects.toThrow("策略");
    }

    await f.manager.close();
  },
);

it("refuses new volumes in ACL recovery mode before starting a helper", async () => {
  const f = await fixture();
  await expect(
    f.manager.start(
      f.id,
      f.directory,
      f.directory,
      f.workspace,
      true,
      f.controller.signal,
      { kind: "local-security" },
    ),
  ).rejects.toThrow("不能创建");
  expect(spawn).not.toHaveBeenCalled();
  await f.manager.close();
});

it("keeps mount identity and policy fixed while allowing identical Local requests", async () => {
  const f = await fixture();
  const start = (source = f.directory, control = f.directory, local = true) =>
    f.manager.start(
      f.id,
      source,
      control,
      f.workspace,
      true,
      f.controller.signal,
      local ? { kind: "local" } : undefined,
    );
  const starting = start();
  f.helper.stdout.write('{"version":1,"state":"ready","mode":"local"}\n');
  await starting;
  await start();
  await expect(start("different-source")).rejects.toThrow("身份");
  await expect(start(f.directory, "different-control")).rejects.toThrow("身份");
  await expect(start(f.directory, f.directory, false)).rejects.toThrow("身份");
  expect(spawn).toHaveBeenCalledTimes(1);
  await f.manager.close();
});

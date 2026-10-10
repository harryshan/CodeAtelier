/**
 * 管理一个测试拥有的异步操作、资源和临时目录，由 helpers 和托管集成夹具使用。
 * 1. TestResources 接入测试取消信号；track 在发起操作前登记，并保留原始结果给调用方。
 * 2. defer 返回幂等的关闭函数，让正文 finally 与超时后的 hook 等待同一次收尾。
 * 3. close 先取消、排空操作，再逆序关闭资源，最后逐个删除目录；失败汇总而不跳过独立资源。
 * 4. currentTestResources 按 Vitest task 保存作用域，afterEach 只清理自己的资源。
 * 不重试删除、不修改测试并发或时限；未接入此作用域的任意 Promise 不会自动获得取消能力。
 */
import { rm } from "node:fs/promises";
import { afterEach } from "vitest";
import { getCurrentTest } from "vitest/suite";

export class TestResources {
  readonly controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private cleanups: Array<() => Promise<void>> = [];
  private directories: string[] = [];
  private closing?: Promise<void>;
  private detachSignal: () => void;

  constructor(signal?: AbortSignal) {
    const abort = () => this.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }

    this.detachSignal = () => signal?.removeEventListener("abort", abort);
  }

  get signal() {
    return this.controller.signal;
  }

  assertOpen() {
    this.signal.throwIfAborted();
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = operation();
    this.pending.add(result);
    // 观察完成但不改变原始 Promise，调用方仍收到自己的失败/取消结果。
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );

    return result;
  }

  defer(cleanup: () => void | Promise<void>) {
    let result: Promise<void> | undefined;
    const close = () => (result ??= Promise.resolve().then(cleanup));
    this.cleanups.push(close);

    return close;
  }

  directory(directory: string) {
    // mkdtemp 可能在取消后才返回；它仍属于已登记的在途操作，必须纳入删除。
    this.directories.push(directory);
  }

  close() {
    this.closing ??= Promise.resolve().then(() => this.dispose());

    return this.closing;
  }

  private async dispose() {
    this.controller.abort();
    this.detachSignal();
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }

    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const directory of this.directories) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, "测试资源清理失败");
    }
  }
}

const scopes = new WeakMap<object, TestResources>();

export function currentTestResources() {
  const test = getCurrentTest();
  if (!test) {
    throw new Error("测试资源必须在 test 或 beforeEach 中创建。");
  }

  let scope = scopes.get(test);
  if (!scope) {
    scope = new TestResources(test.context.signal);
    scopes.set(test, scope);
  }

  scope.assertOpen();

  return scope;
}

afterEach(async ({ task }) => {
  await scopes.get(task)?.close();
});

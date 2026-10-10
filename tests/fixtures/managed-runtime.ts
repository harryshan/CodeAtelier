/**
 * 为 Engine/Store/HTTP 集成测试登记真实运行时资源，不模拟生产行为。
 * 1. TestStore 构造后立即登记 closeAsync；同一次关闭 Promise 由正文和公共 hook 共享。
 * 2. TestEngine 在 Store 之后登记，逆序收尾先取消并等待任务，再允许 Store 释放数据库。
 * 3. createTestApp 跟踪异步构造并登记 app.close，覆盖超时发生在初始化或正文 finally 之前的情况。
 * 只改变测试夹具生命周期，不改变产品 close、追踪事件、权限或测试调度。
 */
import { Engine } from "../../src/agent/engine.js";
import { Store } from "../../src/sessions/store.js";
import { createApp } from "../../src/server/app.js";
import { currentTestResources } from "./test-resources.js";

export class TestStore extends Store {
  constructor(...args: ConstructorParameters<typeof Store>) {
    const scope = currentTestResources();
    super(...args);
    this.closeAsync = scope.defer(() => super.closeAsync());
  }
}

export class TestEngine extends Engine {
  constructor(...args: ConstructorParameters<typeof Engine>) {
    const scope = currentTestResources();
    super(...args);
    this.close = scope.defer(() => super.close());
  }
}

export function createTestApp(...args: Parameters<typeof createApp>) {
  const scope = currentTestResources();

  return scope.track(async () => {
    const fixture = await createApp(...args);
    scope.defer(() => fixture.app.close());
    scope.assertOpen();

    return fixture;
  });
}

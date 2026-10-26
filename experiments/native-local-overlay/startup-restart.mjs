/**
 * startup-probe 的可选正常整应用重启验收，不处理崩溃恢复，也不独立启动服务。
 * 1. controllerIdentity 只向夹具私有 socket 查询 hello，获取 PID/namespace 并与 /proc 核对。
 * 2. verifyNormalRestart 保存双会话历史、round/upper 身份及明确文件检查，通过调用方正常退出并重新启动。
 * 3. 核对旧控制器退出、新 namespace、历史和私有 B/O/T 不变，再通过公开 API 运行真实 Sandbox 续聊。
 * 4. 核对新私有产物未发布、Runtime 标记清空并返回有界摘要；不改设置、不接管未知现场、不重放旧任务。
 * 后续候选发布由 startup-probe 的 --review 场景验证；本模块不将只读续聊当成发布证明。
 */
import assert from "node:assert/strict";
import { lstat, open, readFile, readdir, readlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function controllerIdentity(data) {
  const value = await new Promise((resolve, reject) => {
    const socket = createConnection(
      path.join(data, "local-overlays/controller.sock"),
    );
    let text = "";
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("Controller hello timed out")),
    );
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write('{"version":1,"operation":"hello"}\n'),
    );
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 4096) {
        socket.destroy(new Error("Controller hello exceeded limit"));
      }
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
  assert.equal(value.ok, true);
  assert.equal(value.version, 1);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  assert.equal(await readlink(`/proc/${value.pid}/ns/mnt`), value.namespace);

  return value;
}

async function persistedState(data, sessions) {
  const result = [];
  for (const session of sessions) {
    const control = path.join(data, "local-overlays", session.localOverlay.id);
    const upper = await lstat(path.join(control, "upper"), { bigint: true });
    result.push({
      upperIdentity: `${upper.dev}:${upper.ino}`,
      round: await readFile(path.join(control, "round.json"), "utf8"),
      artifact: await readFile(path.join(control, "upper/artifact"), "utf8"),
    });
  }

  return result;
}

export async function verifyNormalRestart({
  data,
  source,
  sessions,
  request,
  restart,
}) {
  const beforeController = await controllerIdentity(data);
  // 保留旧 namespace 句柄直到比较完成，避免旧进程退出后内核复用其 inode 使数字相同。
  // 句柄不保留 Runtime 或任务；finally 释放，正常视图已由服务关闭。
  const previousNamespace = await open(
    `/proc/${beforeController.pid}/ns/mnt`,
    "r",
  );
  try {
    const beforeState = await persistedState(data, sessions);
    const beforeHistory = [];
    for (const session of sessions) {
      beforeHistory.push(await request(`/api/sessions/${session.id}`));
    }

    const reviewPath = `/api/sessions/${sessions[0].id}/local-review`;
    const beforeReview = await request(reviewPath, { paths: ["artifact"] });
    const previousExit = await restart();
    await assert.rejects(lstat(`/proc/${beforeController.pid}`), {
      code: "ENOENT",
    });
    const afterController = await controllerIdentity(data);
    assert.notEqual(afterController.pid, beforeController.pid);
    assert.notEqual(afterController.namespace, beforeController.namespace);
    assert.deepEqual(await persistedState(data, sessions), beforeState);
    for (const [index, session] of sessions.entries()) {
      const current = await request(`/api/sessions/${session.id}`);
      assert.equal(current.session.localOverlay.state, "ready");
      assert.deepEqual(current.tasks, beforeHistory[index].tasks);
      assert.deepEqual(current.events, beforeHistory[index].events);
    }

    const afterReview = await request(reviewPath, { paths: ["artifact"] });
    assert.deepEqual(afterReview.files, beforeReview.files);
    assert.equal(afterReview.version, beforeReview.version);

    const id = sessions[0].id;
    const task = await request(`/api/sessions/${id}/tasks`, {
      prompt:
        "STARTUP_RESTART: read persisted private files in the new namespace and write an unpublished artifact.",
    });
    const deadline = performance.now() + 45000;
    let snapshot;
    do {
      assert.ok(performance.now() < deadline, "Restart continuation timed out");
      snapshot = await request(`/api/sessions/${id}`);
      await delay(100);
    } while (
      snapshot.tasks.some(
        (entry) =>
          entry.id === task.id && ["queued", "running"].includes(entry.status),
      )
    );

    assert.equal(
      snapshot.tasks.find((entry) => entry.id === task.id)?.status,
      "completed",
    );
    assert.equal(snapshot.session.localOverlay.state, "ready");
    const executions = snapshot.events.filter(
      (event) =>
        event.taskId === task.id &&
        event.type === "execution_instance" &&
        event.data.state === "completed",
    );
    assert.equal(executions.length, 1);
    assert.equal(executions[0].data.mode, "linux-bubblewrap");
    assert.equal(executions[0].data.sandboxApplied, true);
    assert.deepEqual(await readdir(path.join(data, "mxc/active")), []);
    assert.equal(
      await readFile(path.join(source, "module.py"), "utf8"),
      "a = 10\nb = 20\n",
    );
    await assert.rejects(lstat(path.join(source, "restart-private.txt")), {
      code: "ENOENT",
    });
    const privateFile = await request(reviewPath, {
      paths: ["restart-private.txt"],
    });
    assert.equal(
      Buffer.from(privateFile.files[0].ours.content, "base64").toString(),
      "after restart",
    );

    return {
      previousExit,
      oldControllerExited: true,
      newControllerAndNamespace: true,
      historyPreserved: true,
      roundAndUpperPreserved: true,
      reviewPreserved: true,
      sandboxContinuation: true,
      newPrivateArtifactRetained: true,
      sourceUnchanged: true,
      activeRuntimeMarkers: 0,
    };
  } finally {
    await previousNamespace.close();
  }
}

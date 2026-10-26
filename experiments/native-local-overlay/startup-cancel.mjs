/**
 * startup-probe 的 Linux 正常取消、私有保留及新任务发布验收，只使用夹具的公开 HTTP。
 * 1. commandReceipt 校验真实工具回执；cancellationResponse 返回三个固定计划：编辑/选择后等待取消、无发布续聊、重新选择发布。
 * 2. waitTask 等待明确任务终态；executions 只读取同一任务的执行事件，不把宿主命令当 Sandbox 证明。
 * 3. verifyCancellation 等真实命令落下开始标记再取消，核对 cancelled/ready、无候选/来源写入及 B/O 保留。
 * 4. 下一任务重新读取私有修改且不继承选择；再显式选择，通过独立候选发布，保留取消产物与历史。
 * 只在新独占会话上执行，不强杀服务、不重放旧命令或测试异常挂载；报告只含状态/计数。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const calls = new Map();
const suffix = "cancelled_edit = 1\n";

function commandReceipt(body, callId, marker) {
  const receipt = body.input.find(
    (entry) =>
      entry.type === "function_call_output" && entry.call_id === callId,
  );
  assert.ok(receipt, "Command receipt missing");
  const result = JSON.parse(receipt.output);
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.output.includes(marker),
    "Command marker missing from actual output",
  );
}

export function cancellationResponse(body, { python, tool, message }) {
  const serialized = JSON.stringify(body.input);
  const label = serialized.includes("STARTUP_CANCEL_PUBLISH")
    ? "cancel-publish"
    : serialized.includes("STARTUP_CANCEL_CONTINUE")
      ? "cancel-continue"
      : serialized.includes("STARTUP_CANCEL")
        ? "cancel"
        : undefined;
  if (!label) {
    return undefined;
  }

  const step = calls.get(label) ?? 0;
  calls.set(label, step + 1);
  const selection = () =>
    tool(label, step, "local_publish", {
      request: {
        action: "select",
        paths: ["module.py"],
        commands: [
          python(
            "import pathlib; assert pathlib.Path('module.py').read_text().endswith('cancelled_edit = 1\\n'); assert not pathlib.Path('cancel.started').exists(); print('CANCEL_CANDIDATE_OK')",
          ),
        ],
      },
    });
  if (label === "cancel-publish") {
    if (step === 0) {
      return selection();
    }

    assert.equal(step, 1);

    return message();
  }

  if (label === "cancel-continue") {
    if (step === 0) {
      return tool(label, step, "run_command", {
        command: python(
          "import pathlib; assert pathlib.Path('module.py').read_text().endswith('cancelled_edit = 1\\n'); assert pathlib.Path('cancel.started').read_text()=='ready'; assert not pathlib.Path('cancel.finished').exists(); print('CANCEL_CONTINUE_OK')",
        ),
      });
    }

    assert.equal(step, 1);
    commandReceipt(body, "cancel-continue-0", "CANCEL_CONTINUE_OK");

    return message();
  }

  if (step === 0) {
    return tool(label, step, "run_command", {
      command: python(
        "import pathlib; p=pathlib.Path('module.py'); p.write_text(p.read_text()+'cancelled_edit = 1\\n'); print('CANCEL_EDIT_READY')",
      ),
    });
  }

  if (step === 1) {
    commandReceipt(body, "cancel-0", "CANCEL_EDIT_READY");

    return selection();
  }

  assert.equal(
    step,
    2,
    "Cancelled task unexpectedly requested another model step",
  );

  return tool(label, step, "run_command", {
    command: python(
      "import pathlib,time; pathlib.Path('cancel.started').write_text('ready'); time.sleep(60); pathlib.Path('cancel.finished').write_text('not cancelled')",
    ),
  });
}

async function waitTask(request, sessionId, taskId) {
  const deadline = performance.now() + 45000;
  while (true) {
    assert.ok(performance.now() < deadline, "Cancellation scenario timed out");
    const snapshot = await request(`/api/sessions/${sessionId}`);
    const task = snapshot.tasks.find((entry) => entry.id === taskId);
    assert.ok(task);
    if (!["queued", "running"].includes(task.status)) {
      return { snapshot, task };
    }

    await delay(100);
  }
}

function executions(snapshot, taskId) {
  return snapshot.events
    .filter(
      (event) => event.taskId === taskId && event.type === "execution_instance",
    )
    .map((event) => event.data);
}

export async function verifyCancellation({ data, source, request }) {
  const original = await readFile(path.join(source, "module.py"), "utf8");
  const session = await request("/api/sessions", {
    workspace: source,
    localOverlay: { id: randomUUID() },
  });
  const task = await request(`/api/sessions/${session.id}/tasks`, {
    prompt:
      "STARTUP_CANCEL: edit and select the source, then wait for user cancellation.",
  });
  const control = path.join(data, "local-overlays", session.localOverlay.id);
  const started = path.join(control, "upper/cancel.started");
  const deadline = performance.now() + 45000;
  while (true) {
    assert.ok(
      performance.now() < deadline,
      "Cancellation command did not start",
    );
    try {
      assert.equal(await readFile(started, "utf8"), "ready");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await delay(100);
  }

  const running = await request(`/api/sessions/${session.id}`);
  // 选择在活动任务内登记，清单在排空收尾时才保存；用真实计划事件证明选择已完成。
  assert.ok(
    running.events.some(
      (event) =>
        event.taskId === task.id &&
        event.type === "local_validation_plan" &&
        event.data.selected === 1,
    ),
  );
  await request(`/api/tasks/${task.id}/cancel`, {});
  const cancelled = await waitTask(request, session.id, task.id);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(cancelled.snapshot.session.localOverlay.state, "ready");
  assert.equal(
    cancelled.snapshot.session.localOverlay.publication.state,
    "retained",
  );
  const cancelledExecutions = executions(cancelled.snapshot, task.id);
  assert.ok(
    cancelledExecutions.some(
      (entry) =>
        entry.state === "cancelled" &&
        entry.sandboxApplied &&
        entry.mode === "linux-bubblewrap",
    ),
  );
  assert.ok(
    !cancelledExecutions.some(
      (entry) =>
        entry.purpose === "local-validation" || entry.state === "unknown",
    ),
  );
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    original,
  );
  await assert.rejects(lstat(path.join(control, "upper/cancel.finished")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(path.join(data, "mxc/active")), []);
  const review = await request(`/api/sessions/${session.id}/local-review`, {
    paths: ["module.py"],
  });
  assert.equal(
    Buffer.from(review.files[0].base.content, "base64").toString(),
    original,
  );
  assert.equal(
    Buffer.from(review.files[0].ours.content, "base64").toString(),
    original + suffix,
  );

  const continuation = await request(`/api/sessions/${session.id}/tasks`, {
    prompt:
      "STARTUP_CANCEL_CONTINUE: inspect the retained private edit without selecting publication.",
  });
  const continued = await waitTask(request, session.id, continuation.id);
  assert.equal(continued.task.status, "completed");
  assert.equal(continued.snapshot.session.localOverlay.state, "ready");
  assert.ok(
    executions(continued.snapshot, continuation.id).some(
      (entry) =>
        entry.state === "completed" &&
        entry.mode === "linux-bubblewrap" &&
        entry.sandboxApplied,
    ),
  );
  assert.ok(
    !executions(continued.snapshot, continuation.id).some(
      (entry) => entry.purpose === "local-validation",
    ),
  );
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    original,
  );

  const publication = await request(`/api/sessions/${session.id}/tasks`, {
    prompt:
      "STARTUP_CANCEL_PUBLISH: explicitly select the retained source edit and validate a fresh candidate.",
  });
  const published = await waitTask(request, session.id, publication.id);
  assert.equal(published.task.status, "completed");
  assert.equal(
    published.snapshot.session.localOverlay.publication.state,
    "published",
  );
  assert.ok(
    executions(published.snapshot, publication.id).some(
      (entry) =>
        entry.purpose === "local-validation" &&
        entry.state === "completed" &&
        entry.mode === "linux-bubblewrap" &&
        entry.sandboxApplied,
    ),
  );
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    original + suffix,
  );
  assert.equal(await readFile(started, "utf8"), "ready");
  assert.equal(
    published.snapshot.tasks.find((entry) => entry.id === task.id)?.status,
    "cancelled",
  );
  assert.deepEqual(await readdir(path.join(data, "mxc/active")), []);

  return {
    selectedBeforeCancellation: true,
    cancelledAndDrained: true,
    noCandidateOrSourceWriteOnCancellation: true,
    privateEditAndBaseRetained: true,
    continuedWithoutInheritedSelection: true,
    explicitReselectionPublished: true,
    candidateSandboxApplied: true,
    cancellationHistoryPreserved: true,
    privateArtifactRetained: true,
    activeRuntimeMarkers: 0,
  };
}

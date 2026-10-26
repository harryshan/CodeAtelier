/**
 * 私有层中断 verifier 的独立宿主夹具，仅接受父脚本提供的独占来源/控制目录。
 * 1. 直接启动真实 Local helper，传递本宿主 PID，写入覆盖/新建/删除及未完成文件。
 * 2. IPC 提供自己创建的 helper PID，并按父指令异常结束或正常停止 helper，宿主继续存活。
 * 3. 保持文件句柄用于模拟写入中断；只在本夹具内运行，不初始化产品服务或 Sandbox。
 * 4. 可选控制目录/卷路径由产品恢复 verifier 提供，用 restore-local 操作已创建的真实服务视图。
 */
import { spawn } from "node:child_process";
import { open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  overlayHelperPath,
  overlayNamespace,
  overlayWorkspace,
} from "../../src/local-overlays/winfsp-manager.js";

const root = path.resolve(process.argv[2]!);
const restore = process.argv[3] !== undefined;
const workspace = restore
  ? process.argv[4]!
  : overlayWorkspace(overlayNamespace(root), randomUUID());
const helper = spawn(
  overlayHelperPath(),
  [
    restore ? "restore-local" : "create-local",
    path.join(root, "source"),
    restore ? path.resolve(process.argv[3]!) : path.join(root, "control"),
    workspace.slice(1).replace(/\\$/, ""),
    String(process.pid),
  ],
  { windowsHide: true, stdio: "pipe" },
);
const closed = once(helper, "close");
helper.stderr.resume();
await new Promise<void>((resolve, reject) => {
  let buffer = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (text: string) => {
    buffer += text;
    if (buffer.includes("\n")) {
      try {
        const first = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (first.state !== "ready" || first.mode !== "local") {
          throw new Error("Fixture mount failed");
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    }
  });
  helper.on("error", reject);
  helper.on("close", () =>
    reject(new Error("Fixture helper exited before ready")),
  );
});
await writeFile(path.join(workspace, "edit.txt"), "private complete");
await writeFile(path.join(workspace, "new.txt"), "private new");
await unlink(path.join(workspace, "gone.txt"));
const partial = await open(path.join(workspace, "partial.txt"), "w");
await partial.write("private prefix only");
process.send?.({ state: "ready", helper: helper.pid, workspace });
process.on("message", async (command) => {
  if (command === "crash-helper") {
    helper.kill();
  } else if (command === "stop-helper") {
    await partial.close();
    helper.stdin.end("stop\n");
  } else {
    return;
  }

  await closed;
  process.send?.({ state: "helper-exited" });
});

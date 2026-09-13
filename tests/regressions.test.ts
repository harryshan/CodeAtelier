/**
 * 保留配置兼容和文件写入权限方面的缺陷回归，使用真实 Config 和临时文件。
 *
 * 1. 加载旧格式的端点和模型配置，检查规范化结果。
 * 2. 尝试写 Git 元数据，确认直接拒绝，而不是交给用户审批。
 * 3. 覆盖已有文件，检查原权限位仍保留；不支持的系统按条件跳过。
 *
 * 跳过只用于平台不支持的情况，不能靠删掉权限断言消除失败。
 */

import { it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  mkdir,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Config } from "../src/config/config.js";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { ApprovalManager } from "../src/permissions/approval-manager.js";

it("normalizes saved endpoint and preserves model ID on startup", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-config-")));

  try {
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        baseUrl: "http://localhost:1234/v1/responses",
        model: "custom/model-id",
      }),
    );
    const config = new Config(root);

    expect(config.settings.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.settings.model).toBe("custom/model-id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects direct Git metadata edits before asking permission", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-paths-")));

  try {
    await mkdir(path.join(root, ".git"));
    const config = new Config(path.join(root, "data"));
    const approvals = new ApprovalManager(() => {});
    const tools = new ToolRunner({
      root,
      sessionId: "s",
      taskId: "t",
      settings: config.settings,
      signal: new AbortController().signal,
      approvals,
      emit: () => {},
    });

    await expect(
      tools.execute("write_file", { path: ".git/config", content: "no" }),
    ).rejects.toThrow("Git 元数据");
    expect(approvals.list()).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "preserves executable mode after an atomic edit",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-mode-")));

    try {
      const file = path.join(root, "script.sh");

      await writeFile(file, "echo before\n");
      await chmod(file, 0o755);
      const config = new Config(path.join(root, "data"));
      const tools = new ToolRunner({
        root,
        sessionId: "s",
        taskId: "t",
        settings: config.settings,
        signal: new AbortController().signal,
        approvals: new ApprovalManager(() => {}),
        emit: () => {},
      });

      await tools.execute("read_file", {
        path: "script.sh",
        startLine: 1,
        endLine: 10,
      });
      await tools.execute("edit_file", {
        path: "script.sh",
        edits: [{ oldText: "before", newText: "after" }],
      });

      expect((await stat(file)).mode & 0o777).toBe(0o755);
      expect(await readFile(file, "utf8")).toContain("after");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

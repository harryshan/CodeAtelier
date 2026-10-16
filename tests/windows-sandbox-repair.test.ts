/**
 * 验证 Windows Sandbox Repair 保留账户 SID、凭据及失败后的恢复依据。
 * 普通 Vitest 在 Windows 上执行 PowerShell AST 夹具，系统调用由内存替身承接。
 *
 * 1. runRepair 为每个场景创建独立临时 state，执行真实安装器函数和 Mode 分流，再清理夹具。
 * 2. 成功与旧版 state 用例检查持久身份、更新摘要和清理先于复制的顺序。
 * 3. 身份/源文件拒绝和阶段失败用例检查账户保留、状态保留及后续副作用停止。
 * 不创建真实账户、不修改机器 ACL/WFP；这些回归不替代管理员安装态验证。
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalSid = "S-1-5-21-1-2-3-1061";

async function runRepair(scenario: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "sandbox-repair-"));

  try {
    const { stdout } = await execute(
      path.join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "PowerShell/7/pwsh.exe",
      ),
      [
        "-NoProfile",
        "-File",
        fileURLToPath(
          new URL("./fixtures/windows-sandbox-repair.ps1", import.meta.url),
        ),
        "-Installer",
        fileURLToPath(
          new URL("../scripts/windows-sandbox/install.ps1", import.meta.url),
        ),
        "-Directory",
        directory,
        "-Scenario",
        scenario,
      ],
      { windowsHide: true, timeout: 10000 },
    );

    return JSON.parse(stdout) as {
      error: string | null;
      firstError: string | null;
      sid: string | null;
      state: Record<string, string> | null;
      stateUnchanged: boolean;
      operations: string[];
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")(
  "Sandbox account-preserving repair",
  () => {
    it.each(["success", "legacy"])(
      "preserves identity and credential with %s state",
      async (scenario) => {
        const result = await runRepair(scenario);

        expect(result.error).toBeNull();
        expect(result.sid).toBe(originalSid);
        expect(result.state).toMatchObject({
          version: "5",
          accountSid: originalSid,
          protectedPassword: "fixture-protected-password",
          runtimeEntrySha256: "a".repeat(64),
          relayPortV4: scenario === "legacy" ? "42871" : "43971",
          relayPortV6: scenario === "legacy" ? "42872" : "43972",
        });
        expect(result.state?.generationId).not.toBe("previous-generation");
        expect(result.operations.slice(0, 3)).toEqual([
          "--terminate-account-processes",
          "--revoke-journal",
          "copy",
        ]);
        expect(result.operations).not.toContain("create-account");
        expect(result.operations).not.toContain("remove-installation");
        expect(result.operations.at(-1)).toBe("verify");
      },
    );

    it.each([
      "missing-state",
      "missing-account",
      "sid-mismatch",
      "name-mismatch",
      "description-mismatch",
      "installer-mismatch",
      "missing-credential",
      "invalid-port",
      "manifest-failure",
    ])("rejects %s before changing the installation", async (scenario) => {
      const result = await runRepair(scenario);

      expect(result.error).toBeTruthy();
      expect(result.operations).toEqual([]);
      expect(result.stateUnchanged).toBe(scenario !== "missing-state");
    });

    it.each([
      "terminate-failure",
      "revoke-failure",
      "copy-failure",
      "network-failure",
      "verify-failure",
    ])("retains the account and recovery state after %s", async (scenario) => {
      const result = await runRepair(scenario);

      expect(result.error).toContain(scenario);
      expect(result.sid).toBe(originalSid);
      expect(result.state?.accountSid).toBe(originalSid);
      expect(result.state?.protectedPassword).toBe(
        "fixture-protected-password",
      );
      expect(result.operations).not.toContain("remove-installation");
      expect(result.operations).not.toContain("create-account");

      if (scenario !== "verify-failure" && scenario !== "network-failure") {
        expect(result.stateUnchanged).toBe(true);
        expect(result.operations).not.toContain("verify");
      }

      if (scenario === "terminate-failure" || scenario === "revoke-failure") {
        expect(result.operations).not.toContain("copy");
      }
    });

    it("retries a failed repair without losing identity or credentials", async () => {
      const result = await runRepair("retry");

      expect(result.firstError).toBe("verify-failure");
      expect(result.error).toBeNull();
      expect(result.sid).toBe(originalSid);
      expect(result.state?.protectedPassword).toBe(
        "fixture-protected-password",
      );
      expect(
        result.operations.filter((operation) => operation === "verify"),
      ).toHaveLength(2);
      expect(result.operations).not.toContain("remove-installation");
      expect(result.operations).not.toContain("create-account");
    });

    it("honors explicitly supplied relay ports during repair", async () => {
      const result = await runRepair("explicit-ports");

      expect(result.error).toBeNull();
      expect(result.sid).toBe(originalSid);
      expect(result.state).toMatchObject({
        relayPortV4: "44071",
        relayPortV6: "44072",
      });
    });

    it("still creates an account for a fresh install", async () => {
      const result = await runRepair("fresh-install");

      expect(result.error).toBeNull();
      expect(result.sid).toBe("S-1-5-21-1-2-3-9999");
      expect(result.state?.protectedPassword).toBe("new-protected-password");
      expect(result.operations[0]).toBe("create-account");
      expect(result.operations).not.toContain("remove-installation");
    });

    it("rolls back a newly created account after fresh installation fails", async () => {
      const result = await runRepair("fresh-copy-failure");

      expect(result.error).toBe("fresh-copy-failure");
      expect(result.sid).toBeNull();
      expect(result.state).toBeNull();
      expect(result.operations.at(-1)).toBe("remove-installation");
    });
  },
);

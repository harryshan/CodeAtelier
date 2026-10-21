/**
 * 验证 Windows 私有配置 I/O 不受启动终端的 PowerShell 模块搜索路径影响。
 * 1. shadowSecurityModule 在临时目录提供同名安全模块，模拟不兼容的继承模块。
 * 2. 保存/重读测试调用真实 PowerShell 与文件系统，只使用测试字符串。
 * 3. 不安全 ACL 测试使用普通继承权限文件，确认模块隔离不放宽私有权限校验。
 * vi 环境替身在每例结束时恢复，临时目录由公共 fixtures 清理；非 Windows 跳过。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  verifyPrivateSettings,
  writePrivateSettings,
} from "../src/config/private-settings-file.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function shadowSecurityModule() {
  const directory = await temp();
  const moduleDirectory = path.join(directory, "Microsoft.PowerShell.Security");
  await mkdir(moduleDirectory);
  await writeFile(
    path.join(moduleDirectory, "Microsoft.PowerShell.Security.psm1"),
    "function Get-Acl { throw 'Incompatible inherited security module' }\n" +
      "function Set-Acl { throw 'Incompatible inherited security module' }\n" +
      "Export-ModuleMember -Function Get-Acl, Set-Acl\n",
  );
  vi.stubEnv("PSModulePath", directory);
}

it.skipIf(process.platform !== "win32")(
  "saves and verifies private settings with an incompatible inherited security module",
  async () => {
    const file = path.join(await temp(), "settings.json");
    // 先生成合法文件，分别验证只读启动路径与保存路径。
    writePrivateSettings(file, "original fixture");
    await shadowSecurityModule();

    expect(() => verifyPrivateSettings(file)).not.toThrow();
    expect(await readFile(file, "utf8")).toBe("original fixture");
    writePrivateSettings(file, "updated fixture");
    expect(() => verifyPrivateSettings(file)).not.toThrow();
    expect(await readFile(file, "utf8")).toBe("updated fixture");
  },
);

it.skipIf(process.platform !== "win32")(
  "still rejects inherited settings ACLs without rewriting the file",
  async () => {
    const file = path.join(await temp(), "settings.json");
    await writeFile(file, "unchanged fixture");
    await shadowSecurityModule();

    expect(() => verifyPrivateSettings(file)).toThrow("私有 Windows ACL");
    expect(await readFile(file, "utf8")).toBe("unchanged fixture");
  },
);

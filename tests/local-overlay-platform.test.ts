/**
 * Local 平台工厂的纯接线与路径绑定回归，不连接 socket 或模拟原生挂载成功。
 * 1. 普通启动/非 Linux 保留现有 backend 默认，不因无关环境改变平台；入口前提区分 Windows 与未准备平台。
 * 2. 完整 namespace 上下文同时选择 Linux 挂载和候选器；workspace 来自独立视图根。
 * 3. 缺失上下文、来源数据根错配及视图重叠拒绝，不默默选择其它隔离实现。
 * 实际 namespace/Runtime/Publisher 由手动探针验证；Engine 还须将平台前提与 Sandbox 配置共同用于创建门禁。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { localOverlayPlatform } from "../src/local-overlays/platform.js";
import { LinuxCandidateValidator } from "../src/local-overlays/linux-candidate.js";
import { CandidateValidator } from "../src/local-overlays/candidate-validator.js";

const log = pino({ enabled: false });
const directory = path.resolve(".local/platform-test/data");
const root = path.join(directory, "local-overlays");
const views = path.resolve(".local/platform-test/views");
const environment = {
  CODEATELIER_OVERLAY_SOCKET: path.join(root, "controller.sock"),
  CODEATELIER_OVERLAY_ROOT: root,
  CODEATELIER_OVERLAY_VIEWS: views,
};

it("keeps ordinary startup and Windows on their existing implementations", () => {
  expect(
    localOverlayPlatform(directory, log, {}, "linux").backend,
  ).toBeUndefined();
  const windows = localOverlayPlatform(directory, log, environment, "win32");
  expect(windows.backend).toBeUndefined();
  expect(windows.supported).toBe(true);
  expect(localOverlayPlatform(directory, log, {}, "linux").supported).toBe(
    false,
  );
  expect(localOverlayPlatform(directory, log, {}, "darwin").supported).toBe(
    false,
  );
  expect(windows.candidate).toBeInstanceOf(CandidateValidator);
});

it("selects both Linux components from one complete namespace context", () => {
  const result = localOverlayPlatform(directory, log, environment, "linux");
  expect(result.backend?.format).toBe("linux-overlay-v1");
  expect(result.supported).toBe(true);
  expect(result.candidate).toBeInstanceOf(LinuxCandidateValidator);
  const id = randomUUID();
  expect(result.backend?.workspace(id)).toBe(path.join(views, id));
  expect(result.backend?.idFor(path.join(views, id))).toBe(id);
  expect(result.backend?.idFor(path.join(root, id))).toBeUndefined();
});

it.each([
  { CODEATELIER_OVERLAY_SOCKET: "" },
  {
    CODEATELIER_OVERLAY_ROOT: path.resolve(
      ".local/another-data/local-overlays",
    ),
  },
  { CODEATELIER_OVERLAY_VIEWS: "relative" },
  { CODEATELIER_OVERLAY_VIEWS: path.join(directory, "views") },
  { CODEATELIER_OVERLAY_VIEWS: path.dirname(directory) },
])("rejects incomplete or mismatched namespace context %j", (override) => {
  expect(() =>
    localOverlayPlatform(
      directory,
      log,
      { ...environment, ...override },
      "linux",
    ),
  ).toThrow("不会降级");
});

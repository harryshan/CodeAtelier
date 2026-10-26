/**
 * Linux 产品启动计划的离线回归；只生成 argv，不调用编译器、Python 或系统挂载。
 * 1. 正常路径核对同一 data 根传给控制器/服务、独立 views、固定产物和带空格路径的 argv 边界。
 * 2. 拒绝缺失/重叠视图目录、未知选项和不支持平台，避免启动后才降级或改写用户配置。
 * 实际编译、启动与 Sandbox 闭环由显式 WSL 手动验证；默认测试不安装依赖。
 */
import path from "node:path";
import { expect, it } from "vitest";
import { linuxOverlayStartup } from "../src/local-overlays/linux-startup.js";

const root = path.resolve("fixture with spaces");
const data = path.join(root, "data");
const views = path.join(root, "views");
const dist = path.join(root, "dist");
const node = path.join(root, "node");

it("binds the fixed controller and supervisor to the same data directory", () => {
  const result = linuxOverlayStartup(
    ["--", "--data-dir", data, "--views", views],
    dist,
    node,
    "linux",
    "x64",
  );
  expect(result.args).toEqual([
    "-B",
    path.join(dist, "native/linux-x64/launcher.py"),
    "--root",
    path.join(data, "local-overlays"),
    "--views",
    views,
    "--helper",
    path.join(dist, "native/linux-x64/codeatelier-overlay-lower"),
    "--",
    node,
    path.join(dist, "server/server/launcher.js"),
    "--data-dir",
    data,
  ]);
});

it("rejects unavailable or overlapping view roots and unsupported options", () => {
  for (const args of [
    ["--data-dir", data],
    ["--data-dir", data, "--views", data],
    ["--data-dir", data, "--views", path.join(data, "views")],
    ["--data-dir", data, "--views", root],
    ["--data-dir", data, "--views", views, "--helper", "untrusted"],
  ]) {
    expect(() => linuxOverlayStartup(args, dist, node, "linux")).toThrow();
  }
});

it("does not turn another platform into an implicit WSL launch", () => {
  expect(() => linuxOverlayStartup([], dist, node, "win32")).toThrow(
    "不会自动跨 WSL",
  );
});

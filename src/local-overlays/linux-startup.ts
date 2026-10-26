/**
 * 显式 Linux Local 产品入口的参数及固定进程计划，供 overlay-launcher 和离线测试使用。
 * 1. linuxOverlayStartup 拒绝非 Linux/未知参数，复用 startupDirectory 的数据目录语义。
 * 2. 要求调用者指定独立 views 根；控制根从同一数据目录派生，避免 Runtime 私有根重叠。
 * 3. 固定 helper、Python 控制器及服务 supervisor 产物位置，返回 argv，不接受任意服务命令。
 * 此模块不创建目录、不读取源码或设置、不挂载；真实路径身份和 namespace 仍由控制器核验。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { startupDirectory } from "../config/startup.js";
import { inside } from "../tools/paths.js";

export function linuxOverlayStartup(
  args: string[],
  distribution: string,
  node: string,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "linux") {
    throw new Error("start:overlay 当前仅支持 Linux；不会自动跨 WSL 或降级。");
  }

  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: {
      "data-dir": { type: "string" },
      views: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.views) {
    throw new Error("请用 --views 指定独立于数据目录和源码的私有视图目录。");
  }

  const data = startupDirectory(
    values["data-dir"] ? ["--data-dir", values["data-dir"]] : [],
  );
  const views = path.resolve(values.views);
  if (inside(data, views) || inside(views, data)) {
    throw new Error("Local 视图目录和数据目录必须彼此独立。");
  }

  const native = path.join(distribution, "native", `linux-${arch}`);
  const controller = path.join(native, "launcher.py");
  const helper = path.join(native, "codeatelier-overlay-lower");
  const server = path.join(distribution, "server", "server", "launcher.js");

  return {
    helper,
    controller,
    server,
    args: [
      "-B",
      controller,
      "--root",
      path.join(data, "local-overlays"),
      "--views",
      views,
      "--helper",
      helper,
      "--",
      node,
      server,
      "--data-dir",
      data,
    ],
  };
}

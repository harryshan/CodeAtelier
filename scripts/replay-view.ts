/**
 * pnpm replay:view 的手动入口，把已有 replay JSON 转成离线 HTML，或生成空白阅读器供本地选文件。
 * 与 replay:export 分离：本脚本只读显式 input，不打开 SQLite、不启动服务、模型、工具或 Evaluation。
 *
 * 1. parseArgs 校验 --input/--output，兼容 pnpm 传递的可选分隔符。
 * 2. 可选输入经过 JSON 解析，由 replay-viewer/html.ts 校验并安全内嵌到独立文件。
 * 3. 输出只创建不存在的 HTML；成功仅打印保护文件的提示，不打印原始材料或绝对路径。
 *
 * 输出含输入的完整敏感内容，调用者负责选择安全目录；不会自动启动浏览器或覆盖已有文件。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeReplayHtml } from "../src/replay-viewer/html.js";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    input: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.output || path.extname(values.output).toLowerCase() !== ".html") {
  throw new Error("Required: --output NEW_VIEWER.html [--input CASE.json]");
}

const value: unknown = values.input
  ? JSON.parse(await readFile(path.resolve(values.input), "utf8"))
  : null;
await writeReplayHtml(path.resolve(values.output), value);
process.stdout.write(
  "Offline replay viewer created. Open the HTML locally; protect it like the source JSON.\n",
);

/**
 * 为手动 CLI 与测试生成可直接通过 file:// 打开的自包含 Replay 阅读器。
 * 输入为可选的导出 JSON，输出为包含本地脚本、样式和惰性显示数据的 HTML；无数据库或模型依赖。
 *
 * 1. createReplayHtml 先校验输入，用已有 esbuild 打包 browser.ts，并读取本模块旁的固定 CSS。
 * 2. 对 JSON 的 HTML 特殊字符转义，避免载荷关闭 script 标签；脚本/样式使用内容哈希 CSP。
 * 3. writeReplayHtml 仅以 wx 创建新文件，拒绝覆盖；POSIX 使用 0600，Windows 仍依赖目录 ACL。
 *
 * 生成文件保留敏感材料，不额外脱敏或上传；不读取 JSON 内的路径，也不执行其中的工具。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseReplayCase } from "./projection.js";

export async function createReplayHtml(value: unknown = null): Promise<string> {
  if (value !== null) {
    parseReplayCase(value);
  }

  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "none",
  });
  const script = bundle.outputFiles[0].text.replace(
    /<\/script/gi,
    "<\\/script",
  );
  const style = await readFile(
    new URL("./viewer.css", import.meta.url),
    "utf8",
  );
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("base64");
  const payload = JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const policy = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeAtelier · 对话阅读器</title><style>${style}</style></head>
<body><main id="app"></main><noscript>此离线阅读器需要启用 JavaScript，仅在本机显示数据。</noscript>
<script id="replay-data" type="application/json">${payload}</script>
<script>${script}</script></body></html>`;
}

export async function writeReplayHtml(output: string, value: unknown = null) {
  const html = await createReplayHtml(value);
  await writeFile(output, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

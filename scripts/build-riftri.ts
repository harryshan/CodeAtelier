/**
 * 显式构建可选的 Riftri 宿主 helper；由 pnpm worktree:build-native 调用，默认 build/check 不下载工具。
 * 1. 下载固定 v0.6.5 源码归档并核对 SHA-256，解包到 .local/riftri-native。
 * 2. 只公开 Linux/macOS 已有 clone_file 并附加受控单文件 API；不修改上游其他行为。
 * 3. 用 Cargo.lock 构建 native/riftri，复制二进制及上游许可证到固定 dist/native 平台目录。
 * 需要调用者预装 Cargo/Rust 和 tar；不安装系统工具、不修改 Git 配置、文件系统或正在运行的服务。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceHash =
  "f3e4e22e59239e40520d9d1b8b9d90e014ff57cc4ccdd7c36ae16cda34f7a19c";
const root = path.resolve(".local/riftri-native");
const archive = path.join(root, "source.tar.gz");
await mkdir(root, { recursive: true });
let bytes = await readFile(archive).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") {
    return undefined;
  }

  throw error;
});
if (!bytes) {
  const response = await fetch(
    "https://codeload.github.com/assistant-ui/riftri/tar.gz/refs/tags/v0.6.5",
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error("Riftri source download failed");
  }

  bytes = Buffer.from(await response.arrayBuffer());
}

if (createHash("sha256").update(bytes).digest("hex") !== sourceHash) {
  throw new Error("Riftri source checksum mismatch");
}

await writeFile(archive, bytes);
execFileSync("tar", ["-xzf", archive, "-C", root], { stdio: "inherit" });
const upstream = path.join(root, "riftri-0.6.5");
const storage = path.join(upstream, "crates/riftri-storage/src");
for (const backend of ["reflink", "apfs"]) {
  const file = path.join(storage, `${backend}.rs`);
  const text = await readFile(file, "utf8");
  if (text.split("\nfn clone_file(").length !== 2) {
    throw new Error("Unexpected Riftri storage API");
  }

  await writeFile(
    file,
    text.replace("\nfn clone_file(", "\npub(crate) fn clone_file("),
  );
}

const library = path.join(storage, "lib.rs");
await writeFile(
  library,
  (await readFile(library, "utf8")) +
    "\n" +
    (await readFile("native/riftri/storage-api.rs", "utf8")),
);
if (!process.argv.includes("--prepare-only")) {
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      "native/riftri/Cargo.toml",
    ],
    { stdio: "inherit" },
  );
  const output = path.resolve(
    `dist/native/${process.platform}-${process.arch}`,
  );
  const name = `codeatelier-riftri${process.platform === "win32" ? ".exe" : ""}`;
  await mkdir(output, { recursive: true });
  await copyFile(
    path.resolve(
      process.env.CARGO_TARGET_DIR ?? "native/riftri/target",
      "release",
      name,
    ),
    path.join(output, name),
  );
  await copyFile(
    path.join(upstream, "LICENSE"),
    path.join(output, "RIFTRI-LICENSE"),
  );
  process.stdout.write(`Riftri helper built: ${output}\n`);
}

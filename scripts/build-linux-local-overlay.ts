/**
 * pnpm overlay:build-linux 的显式本机编译入口，产物供 start:overlay 使用。
 * 1. parseArgs 读取可选 FUSE 头文件目录/库名；只接受 Linux，不安装编译器或系统依赖。
 * 2. g++ 以 C++20 构建正式只读 lower 到临时文件，失败不覆盖已有 helper。
 * 3. 成功后将 helper 和 namespace launcher 放入 dist/native/linux-<arch>，不挂载或启动服务。
 * 头文件和版本化库参数用于预先解包的开发依赖；默认使用系统 libfuse3-dev。
 * 只生成本机产物，不进入默认 build/check 或 Evaluation；状态写命令行，不写应用历史。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

if (process.platform !== "linux") {
  throw new Error("Linux overlay helper 必须在 Linux 中构建；不会自动跨 WSL。");
}

const { values } = parseArgs({
  options: {
    "include-dir": { type: "string" },
    library: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});
if (values.library && !/^libfuse3\.so(?:\.\d+)*$/.test(values.library)) {
  throw new Error("--library 只接受 libfuse3.so 或其版本化库名。");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "native", "linux-local-overlay");
const output = path.join(root, "dist", "native", `linux-${process.arch}`);
await mkdir(output, { recursive: true });
const temporary = path.join(output, `lower-${randomUUID()}`);
process.stdout.write("INFO overlay.build.started\n");
try {
  execFileSync(
    "g++",
    [
      "-std=c++20",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-D_FILE_OFFSET_BITS=64",
      ...(values["include-dir"]
        ? ["-I", path.resolve(values["include-dir"])]
        : []),
      path.join(source, "readonly-lower.cpp"),
      values.library ? `-Wl,-l:${values.library}` : "-lfuse3",
      "-pthread",
      "-o",
      temporary,
    ],
    { stdio: "inherit" },
  );
  await chmod(temporary, 0o755);
  await rename(temporary, path.join(output, "codeatelier-overlay-lower"));
  await copyFile(
    path.join(source, "launcher.py"),
    path.join(output, "launcher.py"),
  );
  process.stdout.write(`INFO overlay.build.completed output=${output}\n`);
} finally {
  await rm(temporary, { force: true });
}

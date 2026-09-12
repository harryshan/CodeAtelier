/**
 * 文件作用：落实文件工具和命令工具的校验、审批及执行副作用。
 * 代码结构：先定义忽略目录和任务环境；ToolRunner 提供读取指纹、访问检查、遍历与命令授权，再由 execute 分派工具并完成写前复核、原子替换和 diff。
 */

import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { schemas } from "./registry.js";
import type { Settings } from "../shared/types.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import { resolveTarget, regularFile, sensitive, inside } from "./paths.js";
import { executeProcess } from "./process.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".local",
  ".next",
]);

export interface ToolContext {
  root: string;
  sessionId: string;
  taskId: string;
  signal: AbortSignal;
  settings: Settings;
  approvals: ApprovalManager;
  emit: (type: string, data: any) => void;
}

export class ToolRunner {
  private readHashes = new Map<string, string>();
  constructor(private ctx: ToolContext) {}
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  // 先解析真实路径，再决定是否需要审批；不能只按路径字符串判断越界。
  private async access(input: string, write = false) {
    const target = await resolveTarget(this.ctx.root, input);

    if (
      write &&
      target.path.split(/[\\/]/).some((part) => /^\.git$/i.test(part))
    ) {
      throw new Error("初版不支持修改 Git 元数据。");
    }

    if (
      target.outside ||
      target.sensitive ||
      (write && path.basename(target.path).toUpperCase() === "AGENTS.MD")
    ) {
      const ok = await this.ctx.approvals.request(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          tool: write ? "file_write" : "file_read",
          description: (write ? "写入：" : "读取：") + target.path,
        },
        this.ctx.signal,
      );

      if (!ok) {
        throw new Error("用户拒绝了文件访问。");
      }
    }

    this.ctx.signal.throwIfAborted();

    return target.path;
  }

  private async entries(root: string, max = 1500) {
    const result: string[] = [];
    let visited = 0;
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (++visited > max) {
          return;
        }

        if (ignored.has(e.name) || sensitive(e.name) || e.isSymbolicLink()) {
          continue;
        }

        const name = path.join(dir, e.name);

        if (e.isDirectory()) {
          await walk(name);
        } else if (e.isFile()) {
          result.push(name);
        }

        if (visited > max) {
          return;
        }
      }
    };

    await walk(root);

    return { files: result, truncated: visited > max };
  }

  // 会话授权绑定命令、目录和项目内容。源码变化后，旧授权不再复用。
  private async commandGrant(command: string, args: string[], cwd: string) {
    const safe =
      (["pnpm", "npm", "pnpm.cmd", "npm.cmd"].includes(
        path.basename(command).toLowerCase(),
      ) &&
        args.length === 1 &&
        ["test", "build", "lint", "typecheck"].includes(args[0])) ||
      (command === "node" && args.length === 1 && args[0] === "--test");

    if (!safe || !inside(this.ctx.root, cwd)) {
      return undefined;
    }

    const { files, truncated } = await this.entries(this.ctx.root, 1000);

    if (truncated) {
      return undefined;
    }

    const hash = createHash("sha256");

    hash.update(JSON.stringify([command, args, cwd]));
    try {
      for (const file of files.sort()) {
        await regularFile(file, 1024 * 1024);
        hash.update(file);
        hash.update(await readFile(file));
      }
    } catch {
      return undefined;
    }

    return hash.digest("hex");
  }

  async execute(name: string, raw: unknown): Promise<any> {
    this.ctx.signal.throwIfAborted();
    const schema = schemas[name as keyof typeof schemas];

    if (!schema) {
      throw new Error("未知工具");
    }

    const args: any = schema.parse(raw);

    if (name === "read_file" && args.endLine < args.startLine) {
      throw new Error("endLine 不能小于 startLine。");
    }

    if (name === "run_command") {
      const cwd = await this.access(args.cwd);
      const grant = await this.commandGrant(args.command, args.args, cwd);

      if (/^(sudo|su|runas)$/i.test(path.basename(args.command))) {
        throw new Error("初版不支持提权命令。");
      }

      if (
        path.basename(args.command).replace(/\.exe$/i, "") === "git" &&
        args.args.some((a: string) =>
          ["commit", "push", "reset", "clean", "checkout", "restore"].includes(
            a,
          ),
        )
      ) {
        throw new Error("初版不提供 Git 写操作工具。");
      }

      const allowed = await this.ctx.approvals.request(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          tool: name,
          description: JSON.stringify(
            { command: args.command, args: args.args, cwd },
            null,
            2,
          ),
        },
        this.ctx.signal,
        grant,
      );

      if (!allowed) {
        throw new Error("用户拒绝执行命令。");
      }

      return executeProcess(
        args.command,
        args.args,
        cwd,
        this.ctx.signal,
        this.ctx.settings.commandTimeoutMs,
        this.ctx.settings.outputChars,
        (s) => this.ctx.emit("command_output", { text: s }),
      );
    }

    const file = await this.access(
      args.path,
      name === "write_file" || name === "edit_file",
    );

    if (name === "list_files") {
      return (await readdir(file, { withFileTypes: true }))
        .filter((e) => !ignored.has(e.name) && !sensitive(e.name))
        .slice(0, 300)
        .map((e) => ({
          name: e.name,
          type: e.isSymbolicLink()
            ? "link"
            : e.isDirectory()
              ? "directory"
              : "file",
        }));
    }

    if (name === "read_file") {
      await regularFile(file, 2 * 1024 * 1024);
      const text = await readFile(file, "utf8");

      if (text.includes("\0")) {
        throw new Error("不支持二进制文件");
      }

      this.readHashes.set(file, this.hash(text));
      const lines = text.split("\n");
      const end = Math.min(args.endLine, args.startLine + 1999);

      return {
        path: file,
        totalLines: lines.length,
        text: lines
          .slice(args.startLine - 1, end)
          .map((l, i) => `${args.startLine + i}: ${l}`)
          .join("\n"),
      };
    }

    if (name === "search") {
      const { files, truncated } = await this.entries(file);
      const matches: any[] = [];

      for (const name of files) {
        this.ctx.signal.throwIfAborted();
        if (name.toLowerCase().includes(args.query.toLowerCase())) {
          matches.push({
            path: path.relative(this.ctx.root, name),
            kind: "filename",
          });
        }

        if (matches.length >= 100) {
          break;
        }

        try {
          await regularFile(name, 512 * 1024);
          const text = await readFile(name, "utf8");

          if (text.includes("\0")) {
            continue;
          }

          const lines = text.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(args.query.toLowerCase())) {
              matches.push({
                path: path.relative(this.ctx.root, name),
                line: i + 1,
                text: lines[i].slice(0, 500),
              });
              if (matches.length >= 100) {
                break;
              }
            }
          }
        } catch {
          /* Skip unreadable/large files; search remains bounded. */
        }

        if (matches.length >= 100) {
          break;
        }
      }

      return { matches, truncated: truncated || matches.length >= 100 };
    }

    let before = "";
    let exists = true;
    let mode: number | undefined;

    try {
      mode = (await regularFile(file, 2 * 1024 * 1024)).mode;
      before = await readFile(file, "utf8");
    } catch (error: any) {
      if (error.code === "ENOENT") {
        exists = false;
      } else {
        throw error;
      }
    }

    if (exists && this.readHashes.get(file) !== this.hash(before)) {
      throw new Error("文件未读取或已变化，请重新读取后再修改。");
    }

    let after = args.content;

    if (name === "edit_file") {
      if (!exists) {
        throw new Error("文件不存在");
      }

      if (before.split(args.oldText).length !== 2) {
        throw new Error("oldText 必须在文件中精确匹配一次。");
      }

      after = before.replace(args.oldText, () => args.newText);
    }

    if (exists && name === "write_file") {
      const allowed = await this.ctx.approvals.request(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          tool: name,
          description: "完整覆盖已有文件：" + file,
        },
        this.ctx.signal,
      );

      if (!allowed) {
        throw new Error("用户拒绝覆盖文件。");
      }
    }

    // 审批期间用户可能改动路径或文件，因此写入前再次核对。
    const check = await resolveTarget(this.ctx.root, args.path);

    if (check.path !== file) {
      throw new Error("目标路径在审批期间变化。");
    }

    if (exists && (await readFile(file, "utf8")) !== before) {
      throw new Error("文件已变化，请重新读取。");
    }

    this.ctx.signal.throwIfAborted();
    await mkdir(path.dirname(file), { recursive: true });
    // 在同一目录写临时文件后重命名，避免读者看到半写入内容。
    const temp = file + ".codeatelier-" + randomUUID() + ".tmp";

    try {
      await writeFile(temp, after, { flag: "wx" });
      if (mode !== undefined) {
        await chmod(temp, mode);
      }

      this.ctx.signal.throwIfAborted();
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }

    this.readHashes.set(file, this.hash(after));
    const diff = createTwoFilesPatch(
      args.path,
      args.path,
      before,
      after,
      "before",
      "after",
    );

    this.ctx.emit("diff", { path: args.path, diff: diff.slice(0, 100000) });

    return { path: args.path, changed: before !== after, diff };
  }
}

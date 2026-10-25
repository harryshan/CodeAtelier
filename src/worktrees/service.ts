/**
 * 管理显式创建的 Git worktree，并为 Engine/API 提供持久绑定与验证。
 * 输入是用户选择的仓库根、提交基线和请求 UUID；输出是实际 checkout 与来源项目元数据。
 * 1. inspect 只读获取仓库身份和可选分支；create 选择 Riftri 原生克隆或 Git fallback，串行持久化 preparing/ready 清单。
 * 2. 创建使用文件排他锁与 UUID 去重；未知结果保留现场，不删除、不重新 checkout；bind 按 workspace 找回已写历史。
 * 3. describe 装饰历史而不依赖目录存在；validate 在任务 admission/执行/Sandbox 启动前验证目录、gitfile 和共享元数据。
 * 4. projectWorkspace 只映射项目记忆，文件工具和调度仍使用实际路径；close 取消管理进程并排空队列。
 * 清单在 Broker 私有目录，checkout 在其同级目录；日志/trace 只包含关联 ID、状态和耗时。
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { Session, WorktreeInfo } from "../shared/types.js";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import { directoryIdentity, git, samePath } from "./git.js";
import {
  checkoutSchema,
  createCheckout,
  nativeHelperPath,
  selectCheckout,
} from "./riftri.js";

const recordSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  projectWorkspace: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  commonDirectory: z.string(),
  commonIdentity: z.string(),
  state: z.enum(["preparing", "ready", "failed"]),
  workspaceIdentity: z.string().optional(),
  adminDirectory: z.string().optional(),
  checkout: checkoutSchema.optional(),
});
type Record = z.infer<typeof recordSchema>;

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export class WorktreeService {
  readonly root: string;
  private readonly metadata: string;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly traces = new TraceRecorder();
  private readonly archive: TraceArchive;

  constructor(
    directory: string,
    private readonly log: Logger,
    private readonly helperPath = nativeHelperPath(),
  ) {
    const absolute = path.resolve(directory);
    this.root = path.join(
      path.dirname(absolute),
      `${path.basename(absolute)}-worktrees`,
    );
    this.metadata = path.join(absolute, "worktrees");
    this.archive = new TraceArchive(this.metadata, log);
  }

  private file(id: string) {
    return path.join(this.metadata, `${z.uuid().parse(id)}.json`);
  }

  private idFor(workspace: string) {
    const relative = path.relative(this.root, workspace);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }

    // Any path within the managed root must remain managed, even if its manifest is lost.
    const id = relative.split(path.sep)[0];
    if (!z.uuid().safeParse(id).success || relative !== id) {
      throw new Error("不能将托管 Worktree 的根或子目录用作普通工作区。");
    }

    return id;
  }

  private async read(id: string) {
    const record = recordSchema.parse(
      JSON.parse(await readFile(this.file(id), "utf8")),
    );
    if (record.id !== id) {
      throw new Error("Worktree 清单身份不匹配。");
    }

    return record;
  }

  private async save(record: Record) {
    const temporary = `${this.file(record.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, this.file(record.id));
  }

  async inspect(workspace: string) {
    this.controller.signal.throwIfAborted();
    const projectWorkspace = await realpath(workspace);
    if (
      !(await lstat(path.join(projectWorkspace, ".git")).catch(() => undefined))
    ) {
      throw new Error("需要包含 .git 的 Git 工作区根目录。");
    }

    const root = await git(
      projectWorkspace,
      ["rev-parse", "--show-toplevel"],
      this.controller.signal,
    );
    if (!samePath(await realpath(root), projectWorkspace)) {
      throw new Error("请选择 Git 仓库的工作区根目录。");
    }

    const commonDirectory = await realpath(
      await git(
        projectWorkspace,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        this.controller.signal,
      ),
    );
    const branches = (
      await git(
        projectWorkspace,
        ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"],
        this.controller.signal,
      )
    )
      .split("\n")
      .filter(Boolean);

    return { projectWorkspace, commonDirectory, branches };
  }

  async describe(session: Session): Promise<Session> {
    const id = this.idFor(session.workspace);
    if (!id) {
      return session;
    }

    try {
      const record = await this.read(id);
      const worktree: WorktreeInfo = {
        id,
        projectWorkspace: record.projectWorkspace,
        baseRef: record.baseRef,
        baseCommit: record.baseCommit,
        state: record.state,
        backend: record.checkout?.backend ?? "git",
        fallbackReason: record.checkout?.fallbackReason,
        clonedFiles: record.checkout?.clonedFiles,
      };

      return { ...session, worktree };
    } catch {
      return { ...session, worktree: { id, state: "unavailable" } };
    }
  }

  async validate(workspace: string) {
    const id = this.idFor(workspace);
    if (!id) {
      return undefined;
    }

    try {
      const record = await this.read(id);
      await this.assertPrivateDataDisjoint(record.commonDirectory);
      if (
        record.state !== "ready" ||
        (await directoryIdentity(workspace)) !== record.workspaceIdentity ||
        (await directoryIdentity(record.commonDirectory)) !==
          record.commonIdentity
      ) {
        throw new Error("Worktree 身份改变。");
      }

      const gitfile = (
        await readFile(path.join(workspace, ".git"), "utf8")
      ).trim();
      if (!gitfile.startsWith("gitdir: ") || !record.adminDirectory) {
        throw new Error("Worktree Git 指针无效。");
      }

      const admin = await realpath(path.resolve(workspace, gitfile.slice(8)));
      const common = await realpath(
        path.resolve(
          admin,
          (await readFile(path.join(admin, "commondir"), "utf8")).trim(),
        ),
      );
      const backlink = (
        await readFile(path.join(admin, "gitdir"), "utf8")
      ).trim();
      if (
        !samePath(admin, record.adminDirectory) ||
        !samePath(common, record.commonDirectory) ||
        !samePath(path.resolve(admin, backlink), path.join(workspace, ".git"))
      ) {
        throw new Error("Worktree Git 关联改变。");
      }

      return record;
    } catch {
      throw new Error(
        "Worktree 不可用或身份已改变。请检查原仓库、实际目录及创建清单；不会回退原项目或自动重建。",
      );
    }
  }

  async projectWorkspace(workspace: string) {
    return (await this.validate(workspace))?.projectWorkspace ?? workspace;
  }

  async gitWriteRoots(workspace: string) {
    const record = await this.validate(workspace);

    return record ? [record.commonDirectory] : [];
  }

  create(
    input: { id: string; workspace: string; baseRef: string },
    bind: (workspace: string) => Promise<Session>,
  ) {
    const operation = this.pending.then(() => this.createSerial(input, bind));
    this.pending = operation.catch(() => {});

    return operation;
  }

  private async assertPrivateDataDisjoint(commonDirectory: string) {
    // Configured data paths can be junctions; lexical comparison would grant the private target.
    const privateRoot = await realpath(path.dirname(this.metadata));
    if (
      contains(commonDirectory, privateRoot) ||
      contains(privateRoot, commonDirectory)
    ) {
      throw new Error("Git 公共目录不能与 Broker 私有数据目录重叠。");
    }
  }

  /** Persist intent before Git; failed or cancelled checkout is retained for inspection. */
  private async prepareCheckout(
    input: { id: string; workspace: string; baseRef: string },
    workspace: string,
    operationId: string,
  ) {
    const repository = await this.inspect(input.workspace);
    await this.assertPrivateDataDisjoint(repository.commonDirectory);
    if (contains(repository.projectWorkspace, this.root)) {
      throw new Error(
        "托管 Worktree 目录不能位于来源仓库内，请将服务数据目录设在项目之外。",
      );
    }

    await mkdir(this.root, { recursive: true });
    await directoryIdentity(this.root);
    const baseCommit = await git(
      repository.projectWorkspace,
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRef}^{commit}`,
      ],
      this.controller.signal,
    );
    const selection = await selectCheckout(
      repository.projectWorkspace,
      this.root,
      this.controller.signal,
      this.helperPath,
    );
    const record: Record = {
      version: 1,
      id: input.id,
      projectWorkspace: repository.projectWorkspace,
      baseRef: input.baseRef,
      baseCommit,
      commonDirectory: repository.commonDirectory,
      commonIdentity: await directoryIdentity(repository.commonDirectory),
      state: "preparing",
      checkout: selection,
    };
    await this.save(record);
    const span = this.traces.startSpan(operationId, {
      name: "worktree.checkout",
      category: "worktree",
      track: "Worktree management",
      attributes: {
        backend: selection.backend,
        fallbackReason: selection.fallbackReason ?? "none",
      },
    });
    let outcome: "ok" | "error" | "cancelled" = "error";
    try {
      record.checkout = await createCheckout(
        repository.projectWorkspace,
        workspace,
        baseCommit,
        selection,
        this.controller.signal,
        this.helperPath,
      );
      this.log.info({
        module: "worktree",
        event: "worktree.checkout_finished",
        worktreeId: input.id,
        ...record.checkout,
      });
      record.workspaceIdentity = await directoryIdentity(workspace);
      record.adminDirectory = await realpath(
        await git(
          workspace,
          ["rev-parse", "--absolute-git-dir"],
          this.controller.signal,
        ),
      );
      record.state = "ready";
      await this.save(record);
      await this.validate(workspace);
      outcome = "ok";
    } catch (error) {
      record.state = "failed";
      await this.save(record).catch(() => {});
      throw error;
    } finally {
      this.traces.endSpan(
        span,
        this.controller.signal.aborted ? "cancelled" : outcome,
      );
    }
  }

  private async createSerial(
    input: { id: string; workspace: string; baseRef: string },
    bind: (workspace: string) => Promise<Session>,
  ) {
    const id = z.uuid().parse(input.id);
    this.controller.signal.throwIfAborted();
    await mkdir(this.metadata, { recursive: true });
    // A leftover lock is evidence of an unknown result. Never guess whether another process is alive.
    const lock = await open(
      path.join(this.metadata, "creation.lock"),
      "wx",
      0o600,
    ).catch(() => {
      throw new Error(
        "Worktree 管理正在进行或上次创建未确认结束；请检查创建清单与 creation.lock，不会自动重放。",
      );
    });
    const operationId = randomUUID();
    const started = performance.now();
    this.traces.startTask(operationId, id);
    const span = this.traces.startSpan(operationId, {
      name: "worktree.create",
      category: "worktree",
      track: "Worktree management",
      attributes: { worktreeId: id },
    });
    let outcome: "ok" | "error" | "cancelled" = "error";
    this.log.info({
      module: "worktree",
      event: "worktree.create_started",
      worktreeId: id,
      operationId,
    });
    try {
      const workspace = path.join(this.root, id);
      let record: Record | undefined;
      try {
        record = await this.read(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (record) {
        if (
          !samePath(record.projectWorkspace, await realpath(input.workspace)) ||
          record.baseRef !== input.baseRef
        ) {
          throw new Error("相同 Worktree 请求 ID 不能改变来源或基线。");
        }

        await this.validate(workspace);
      } else {
        await this.prepareCheckout(input, workspace, operationId);
      }

      // Match Local session creation: the scheduler key must use filesystem spelling on Windows.
      const session = await this.describe(
        await bind(await realpath(workspace)),
      );
      const checkoutSpan = this.traces.startSpan(operationId, {
        name: "worktree.backend",
        category: "worktree",
        track: "Worktree management",
        attributes: {
          backend: session.worktree?.backend ?? "git",
          fallbackReason: session.worktree?.fallbackReason ?? "none",
          clonedFiles: session.worktree?.clonedFiles ?? 0,
        },
      });
      this.traces.endSpan(checkoutSpan, "ok");
      outcome = "ok";

      return session;
    } finally {
      if (this.controller.signal.aborted) {
        outcome = "cancelled";
      }

      this.traces.endSpan(span, outcome);
      this.traces.finishTask(operationId, outcome);
      await this.archive.write(
        id,
        operationId,
        this.traces.exportTask(operationId),
      );
      this.traces.discardTask(operationId);
      this.log.info({
        module: "worktree",
        event: "worktree.create_finished",
        worktreeId: id,
        operationId,
        outcome,
        durationMs: performance.now() - started,
      });
      await lock.close();
      await unlink(path.join(this.metadata, "creation.lock"));
    }
  }

  async close() {
    this.controller.abort();
    await this.pending;
  }
}

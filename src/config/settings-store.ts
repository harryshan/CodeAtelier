/**
 * 统一设置事务服务，由 Config 持有；HTTP 路由只接触安全视图与有 revision 的局部更新。
 * 1. 构造时读严格版本文件或接收显式旧配置候选；记录原始磁盘文本检测外部漂移。
 * 2. prepare 合并公开字段、独立凭据操作和按 ID 的 MCP 替换，校验跨连接凭据确认及风险确认。
 * 3. update 串行派生/保存，并以独占写锁和发布前漂移检查协调合作进程；成功才发布 revision。
 *    崩溃锁不自动清除；旧文件迁移先留私有备份，不删除 dotenv。
 * 4. reload 显式重新读取；view 比较启动值报告待重启组，任务快照由 Config 独立复制。
 * 错误只含固定消息或字段路径，不附 JSON/Zod/系统异常，避免泄露新输入的凭据。
 */
import { randomUUID } from "node:crypto";
import { openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  documentSchema,
  defaultDocument,
  patchSchema,
  publicDocument,
  type SettingsDocument,
} from "./settings-document.js";
import { hashPassword } from "./password.js";
import {
  SettingsFileConflict,
  readSettingsText,
  verifyPrivateSettings,
  writePrivateSettings,
} from "./private-settings-file.js";

export class SettingsConflict extends SettingsFileConflict {}

export function parseDocument(text: string): SettingsDocument {
  try {
    return documentSchema.parse(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    throw new Error(
      "设置文件无效或版本不支持；请本地修复，不会覆盖文件或关闭门禁。",
    );
  }
}

export class SettingsStore {
  private current: SettingsDocument;
  private baseline: string | null;
  private revision = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  readonly initial: SettingsDocument;
  readonly file: string;
  legacy: boolean;

  constructor(directory: string, legacyCandidate?: SettingsDocument) {
    this.file = path.join(directory, "settings.json");
    this.baseline = readSettingsText(this.file);
    this.legacy = !!legacyCandidate;
    if (!legacyCandidate && this.baseline !== null) {
      verifyPrivateSettings(this.file);
    }

    this.current =
      legacyCandidate ??
      (this.baseline === null
        ? defaultDocument()
        : parseDocument(this.baseline));
    this.initial = structuredClone(this.current);
  }

  get document() {
    return structuredClone(this.current);
  }

  view() {
    const pendingRestart = (["server", "sandbox"] as const).filter(
      (group) =>
        JSON.stringify(this.initial[group]) !==
        JSON.stringify(this.current[group]),
    );
    const tracingRestart =
      this.initial.tracing.checkpointMs !== this.current.tracing.checkpointMs ||
      this.initial.tracing.retentionDays !== this.current.tracing.retentionDays;

    return {
      revision: this.revision,
      path: this.file,
      migrationRequired: this.legacy,
      pendingRestart: [
        ...pendingRestart,
        ...(tracingRestart ? ["tracing"] : []),
      ],
      configuration: publicDocument(structuredClone(this.current)),
    };
  }

  private assertRevision(revision: string) {
    if (
      revision !== this.revision ||
      readSettingsText(this.file) !== this.baseline
    ) {
      throw new SettingsConflict(
        "配置已变化；草稿未保存，请重新读取后重新应用更改。",
      );
    }
  }

  private async prepare(input: unknown) {
    const parsed = patchSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("设置更新格式无效；检查字段名称、类型及范围。");
    }

    const patch = parsed.data;
    this.assertRevision(patch.expectedRevision);
    const next = this.document;
    const { models, ...groups } = patch.changes;
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      Object.assign(next[group], groups[group]);
    }

    Object.assign(next.models.main, models?.main);
    Object.assign(next.models.auxiliary, models?.auxiliary);
    const keys = patch.secretChanges;
    for (const which of ["main", "auxiliary"] as const) {
      const previous = this.current.models[which];
      const changed = next.models[which];
      const key = which === "main" ? keys.mainKey : keys.auxiliaryKey;
      const changedTarget =
        previous.baseUrl !== changed.baseUrl ||
        previous.protocol !== changed.protocol ||
        (which === "auxiliary" &&
          (this.current.models.auxiliary.inheritConnection !==
            next.models.auxiliary.inheritConnection ||
            (next.models.auxiliary.inheritConnection &&
              (next.models.main.baseUrl !== this.current.models.main.baseUrl ||
                next.models.main.protocol !==
                  this.current.models.main.protocol))));
      if (changedTarget && previous.apiKey && key === undefined) {
        throw new Error("连接目标变化，请重新输入或明确删除对应密钥。");
      }

      if (key !== undefined) {
        changed.apiKey = key;
      }
    }

    if (keys.password !== undefined) {
      next.server.passwordHash = await hashPassword(keys.password);
    }

    for (const [id, server] of Object.entries(patch.mcpChanges ?? {})) {
      if (server === null) {
        delete next.mcp.servers[id];
      } else {
        next.mcp.servers[id] = server;
      }
    }

    const valid = documentSchema.safeParse(next);
    if (!valid.success) {
      const fields = valid.error.issues
        .map((issue) => issue.path.join("."))
        .slice(0, 8)
        .join("、");
      throw new Error(`设置校验失败，请检查：${fields}`);
    }

    const riskChanged =
      JSON.stringify(next.sandbox) !== JSON.stringify(this.current.sandbox) ||
      (next.server.listenAddress !== this.current.server.listenAddress &&
        ["0.0.0.0", "::"].includes(next.server.listenAddress)) ||
      (this.current.server.passwordEnabled && !next.server.passwordEnabled) ||
      (next.tracing.retentionDays > 0 &&
        (this.current.tracing.retentionDays === 0 ||
          next.tracing.retentionDays < this.current.tracing.retentionDays));
    if (riskChanged && !patch.confirmSensitive) {
      throw new Error("权限、访问范围或归档删除策略变化，需要确认影响后保存。");
    }

    return { patch, next: valid.data };
  }

  async validate(input: unknown) {
    await this.prepare(input);

    return { valid: true };
  }

  update(input: unknown) {
    const operation = this.queue.then(async () => {
      const { patch, next } = await this.prepare(input);
      if (this.legacy && !patch.confirmMigration) {
        throw new Error(
          "旧配置需要显式确认迁移；密钥将写入私有 settings.json。",
        );
      }

      // 协作进程使用独占锁，崩溃遗留锁需人工核实；外部编辑器仍须在 rename 前再次比对。
      const lockFile = this.file + ".write-lock";
      let lock: number;
      try {
        lock = openSync(lockFile, "wx", 0o600);
      } catch {
        throw new SettingsConflict(
          "设置写入锁被占用；请确认其它实例或中断写入状态，不自动重试。",
        );
      }

      try {
        this.assertRevision(patch.expectedRevision);
        if (this.legacy && this.baseline !== null) {
          writePrivateSettings(
            `${this.file}.pre-v1-${randomUUID()}.bak`,
            this.baseline,
          );
        }

        const text = JSON.stringify(next, null, 2) + "\n";
        writePrivateSettings(this.file, text, () =>
          this.assertRevision(patch.expectedRevision),
        );
        this.current = next;
        this.baseline = text;
        this.legacy = false;
        this.revision = randomUUID();

        return this.view();
      } finally {
        closeSync(lock);
        unlinkSync(lockFile);
      }
    });
    this.queue = operation.catch(() => undefined);

    return operation;
  }

  reload(expectedRevision: string) {
    const operation = this.queue.then(() => {
      if (expectedRevision !== this.revision || this.legacy) {
        throw new SettingsConflict(
          "配置版本已变化或仍为旧格式，请重新打开设置。",
        );
      }

      const text = readSettingsText(this.file);
      if (text === null) {
        throw new Error("设置文件缺失，不会回退默认配置。");
      }

      verifyPrivateSettings(this.file);
      const next = parseDocument(text);
      this.current = next;
      this.baseline = text;
      this.revision = randomUUID();

      return this.view();
    });
    this.queue = operation.catch(() => undefined);

    return operation;
  }
}

export type SettingsEditorView = ReturnType<SettingsStore["view"]>;

/**
 * 版本化设置文件的纯校验与投影，供 SettingsStore、Config 和设置 UI 的类型导入使用。
 * 1. documentSchema 定义私有磁盘结构；空主连接只允许进入初始设置，不表示可以启动任务。
 * 2. patchSchema 限制可编辑字段，凭据与 MCP 替换独立提交，不接受公开掩码作为旧密钥。
 * 3. runtimeSettings 转换为既有引擎 Settings；publicDocument 显式移除凭据和 MCP 连接参数。
 * 本模块不读环境、不访问磁盘、不连接服务；旧环境配置由显式迁移路径提供。
 */
import { z } from "zod";
import path from "node:path";
import { modelProtocolSchema, persistedSettingsSchema } from "./settings.js";
import { mcpServerSchema } from "../mcp/config.js";
import type { Settings } from "../shared/types.js";

const endpoint = z
  .string()
  .max(8192)
  .refine((value) => {
    if (!value) {
      return true;
    }

    try {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  })
  .transform((value) =>
    value
      .replace(/\/(responses|chat\/completions|messages)\/?$/, "")
      .replace(/\/$/, ""),
  );
const effort = z.enum(["none", "low", "medium", "high"]);
const model = z
  .object({
    protocol: modelProtocolSchema.default("responses"),
    baseUrl: endpoint.default(""),
    model: z.string().trim().max(200).default(""),
    apiKey: z.string().max(4096).default(""),
    reasoningEffort: effort.default("high"),
  })
  .strict();
const auxiliary = model
  .extend({
    enabled: z.boolean().default(false),
    inheritConnection: z.boolean().default(true),
    inheritKey: z.boolean().default(true),
    reasoningEffort: effort.default("low"),
  })
  .strict();
const preferences = persistedSettingsSchema.parse({
  maxSteps: 100,
  requestTimeoutMs: 300000,
  idleTimeoutMs: 60000,
  contextChars: 1000000,
  outputChars: 32000,
  logLevel: "info",
});
const execution = persistedSettingsSchema
  .pick({
    maxSteps: true,
    maxConcurrentTasks: true,
    requestTimeoutMs: true,
    idleTimeoutMs: true,
    outputChars: true,
  })
  .strict();
const context = persistedSettingsSchema
  .pick({
    maxOutputTokens: true,
    maxContextTokens: true,
    contextChars: true,
  })
  .strict();
const root = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"));
const sandbox = z
  .object({
    enabled: z.boolean().default(false),
    readRoots: z.array(root).max(32).default([]),
    writeRoots: z.array(root).max(32).default([]),
    nativeRoot: z.union([root, z.literal("")]).default(""),
    statePath: z.union([root, z.literal("")]).default(""),
  })
  .strict();
const server = z
  .object({
    listenAddress: z
      .enum(["127.0.0.1", "::1", "0.0.0.0", "::"])
      .default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(4142),
    passwordEnabled: z.boolean().default(false),
    passwordHash: z
      .string()
      .regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/)
      .or(z.literal(""))
      .default(""),
  })
  .strict();
const tracing = z
  .object({
    maxRecords: z.number().int().min(100).max(1000000).default(100000),
    maxBytes: z.number().int().min(65536).max(268435456).default(33554432),
    checkpointMs: z.number().int().min(5000).max(3600000).default(30000),
    retentionDays: z.number().int().min(0).max(3650).default(0),
  })
  .strict();
const logging = z
  .object({ level: persistedSettingsSchema.shape.logLevel.default("info") })
  .strict();
const serverId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const servers = z
  .record(serverId, mcpServerSchema)
  .refine((value) => Object.keys(value).length <= 32);

export const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    models: z.object({ main: model, auxiliary }).strict(),
    execution,
    context,
    sandbox,
    server,
    tracing,
    logging,
    mcp: z.object({ servers }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.server.passwordEnabled && !value.server.passwordHash) {
      ctx.addIssue({
        code: "custom",
        path: ["server", "passwordEnabled"],
        message: "启用门禁前请设置密码。",
      });
    }

    const aux = value.models.auxiliary;
    if (
      aux.enabled &&
      (!aux.model || (!aux.inheritConnection && !aux.baseUrl))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["models", "auxiliary"],
        message: "辅助模型配置不完整。",
      });
    }

    if (
      aux.enabled &&
      aux.inheritKey &&
      !aux.inheritConnection &&
      (aux.baseUrl !== value.models.main.baseUrl ||
        aux.protocol !== value.models.main.protocol)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["models", "auxiliary", "inheritKey"],
        message: "跨连接不能继承主密钥。",
      });
    }
  });

export type SettingsDocument = z.infer<typeof documentSchema>;
/** PATCH 的省略字段必须保持省略；不能让磁盘 schema 的 default 在 partial 内重新填充值。 */
function patchObject<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  type PatchShape = {
    [K in keyof T]: z.ZodOptional<
      T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]
    >;
  };
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      z.optional(field instanceof z.ZodDefault ? field.removeDefault() : field),
    ]),
  ) as PatchShape;

  return z.object(shape).strict();
}

export const patchSchema = z
  .object({
    expectedRevision: z.string().min(1).max(100),
    confirmMigration: z.boolean().optional(),
    confirmSensitive: z.boolean().optional(),
    changes: z
      .object({
        models: z
          .object({
            main: patchObject(model.omit({ apiKey: true })).optional(),
            auxiliary: patchObject(auxiliary.omit({ apiKey: true })).optional(),
          })
          .strict()
          .optional(),
        execution: patchObject(execution).optional(),
        context: patchObject(context).optional(),
        sandbox: patchObject(sandbox).optional(),
        server: patchObject(server.omit({ passwordHash: true })).optional(),
        logging: patchObject(logging).optional(),
        tracing: patchObject(tracing).optional(),
      })
      .strict()
      .default({}),
    secretChanges: z
      .object({
        mainKey: z.string().max(4096).optional(),
        auxiliaryKey: z.string().max(4096).optional(),
        password: z.string().min(1).max(1024).optional(),
      })
      .strict()
      .default({}),
    mcpChanges: z.record(serverId, mcpServerSchema.nullable()).optional(),
  })
  .strict();

export function defaultDocument(): SettingsDocument {
  return documentSchema.parse({
    schemaVersion: 1,
    models: { main: {}, auxiliary: {} },
    execution: {
      maxSteps: preferences.maxSteps,
      maxConcurrentTasks: preferences.maxConcurrentTasks,
      requestTimeoutMs: preferences.requestTimeoutMs,
      idleTimeoutMs: preferences.idleTimeoutMs,
      outputChars: preferences.outputChars,
    },
    context: context.parse({
      maxOutputTokens: preferences.maxOutputTokens,
      maxContextTokens: preferences.maxContextTokens,
      contextChars: preferences.contextChars,
    }),
    sandbox: {},
    server: {},
    logging: {},
    tracing: {},
    mcp: { servers: {} },
  });
}

export function runtimeSettings(value: SettingsDocument): Settings {
  const main = value.models.main;
  const aux = value.models.auxiliary;

  return {
    ...value.execution,
    ...value.context,
    commandTimeoutMs: 0,
    logLevel: value.logging.level,
    protocol: main.protocol,
    baseUrl: main.baseUrl,
    model: main.model,
    reasoningEffort: main.reasoningEffort,
    auxiliaryModel: aux.enabled ? aux.model : "",
    auxiliaryProtocol: aux.inheritConnection ? main.protocol : aux.protocol,
    auxiliaryBaseUrl: aux.inheritConnection ? main.baseUrl : aux.baseUrl,
    auxiliaryReasoningEffort: aux.reasoningEffort,
  };
}

export function publicDocument(value: SettingsDocument) {
  const { apiKey: mainKey, ...main } = value.models.main;
  const { apiKey: auxiliaryKey, ...auxiliaryValue } = value.models.auxiliary;
  const { passwordHash, ...serverValue } = value.server;

  return {
    schemaVersion: value.schemaVersion,
    models: {
      main: { ...main, hasKey: !!mainKey },
      auxiliary: { ...auxiliaryValue, hasKey: !!auxiliaryKey },
    },
    execution: value.execution,
    context: value.context,
    sandbox: value.sandbox,
    server: { ...serverValue, hasPassword: !!passwordHash },
    logging: value.logging,
    tracing: value.tracing,
    mcp: {
      servers: Object.entries(value.mcp.servers).map(([id, entry]) => ({
        id,
        enabled: entry.enabled,
        transport: entry.transport,
        configured: true,
      })),
    },
  };
}

export type PublicSettingsDocument = ReturnType<typeof publicDocument>;

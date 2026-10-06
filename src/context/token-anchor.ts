/**
 * 定义跨任务 token 校准锚点，供预算、Store 与 Runtime IPC 共用；不保存提示词、源码或服务地址。
 *
 * 1. tokenAnchorSchema 校验版本、编码器、SHA-256 指纹和安全整数，旧格式或坏记录不能参与预算。
 * 2. tokenScope 只在 Broker/宿主根据模型连接与思考配置生成指纹；容量设置不属于计量身份。
 * 3. tokenDigest 与 tokenPrefixHash 校验序列化内容；新任务只扫描旧前缀，不重新 tokenizer 编码。
 *    哈希用于内容一致性而不是认证，不能扩大 Runtime 权限或代表服务精确计量。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenAnchorSchema = z
  .object({
    version: z.literal(1),
    tokenizer: z.literal("o200k_base"),
    scope: digest,
    toolsHash: digest,
    instructionsHash: digest,
    prefixHash: digest,
    inputItems: count,
    rawTokens: count,
    fixedTokens: count,
    actualInputTokens: count,
  })
  .strict()
  .refine((value) => value.rawTokens >= value.fixedTokens);
export type TokenAnchor = z.infer<typeof tokenAnchorSchema>;

export function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tokenScope(settings: {
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
}): string {
  return tokenDigest(
    JSON.stringify([
      settings.baseUrl,
      settings.model,
      settings.reasoningEffort ?? "high",
    ]),
  );
}

export function tokenItemText(item: unknown, index: number): string {
  return (index === 0 ? "" : ",") + (JSON.stringify(item) ?? "null");
}

export function tokenPrefixHash(input: unknown[], length: number) {
  const hash = createHash("sha256");
  for (let index = 0; index < length; index++) {
    hash.update(tokenItemText(input[index], index));
  }

  return hash;
}

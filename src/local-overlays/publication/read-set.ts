/**
 * 主任务批次和候选验证共用的工程读集预算，不涉及文件内容或实际 I/O。
 * 1. MAX_READS 限制观察导出与序列化条目数；历史代次和选定修改仍使用各自限制。
 * 2. readSetSchema 校验字段形状和 JSON 编码后的累计 UTF-8 字节，计入转义以约束日志内存。
 * 3. 调用方继续负责路径语义、重复项、原生观察和读取版本复核，不凭 schema 推断数据仍有效。
 *    kind=directory 是已枚举目录的成员依赖；省略时保持普通文件/缺失路径的旧语义。
 */
import { z } from "zod";

export const MAX_READS = 10_000;
export const MAX_READ_SET_BYTES = 4 * 1024 * 1024;

export const readSetSchema = z
  .array(
    z.object({
      path: z.string().min(1).max(1024),
      version: z.string().min(1).max(1024),
      kind: z.literal("directory").optional(),
    }),
  )
  .max(MAX_READS)
  .refine(
    (reads) =>
      reads.reduce(
        (sum, read) => sum + Buffer.byteLength(JSON.stringify(read)),
        0,
      ) <= MAX_READ_SET_BYTES,
    "READ_SET_LIMIT",
  );

/**
 * 解析有界 SKILL.md，供 TaskSkills 扫描元信息和加载正文；不解释或执行 Markdown 中的命令。
 * 1. 常量限制文件、YAML 头和目录规模，避免发现过程无限占用内存或模型上下文。
 * 2. parseSkillDocument 处理 UTF-8/BOM/CRLF、YAML name/description 和非空正文。
 *    js-yaml 使用 JSON_SCHEMA，不启用自定义类型；其它元信息忽略，特别是 allowed-tools 不授予权限。
 * 3. 只返回经过类型和长度校验的两个字符串及正文，不序列化 YAML 的其它对象或别名图。
 * 错误使用固定消息，不将解析器可能包含源码的异常片段写入日志或 trace。
 */
import { JSON_SCHEMA, load } from "js-yaml";
import { skillNameSchema } from "./contracts.js";

export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_FRONTMATTER_CHARS = 8 * 1024;
export const MAX_SKILLS = 64;
export const MAX_ROOT_ENTRIES = 512;

export function parseSkillDocument(bytes: Uint8Array, directoryName: string) {
  if (bytes.byteLength > MAX_SKILL_BYTES) {
    throw new Error("Skill 文件超过 64 KiB 限制。");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Skill 文件不是有效 UTF-8。");
  }

  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") || text.includes("\0")) {
    throw new Error("Skill 缺少 YAML frontmatter 或包含二进制内容。");
  }

  const end = text.indexOf("\n---\n", 4);
  if (end < 0 || end > MAX_FRONTMATTER_CHARS) {
    throw new Error("Skill YAML frontmatter 未闭合或超过限制。");
  }

  let metadata: unknown;
  try {
    metadata = load(text.slice(4, end), { schema: JSON_SCHEMA });
  } catch {
    throw new Error("Skill YAML frontmatter 无效。");
  }

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Skill 元信息必须是对象。");
  }

  const fields = metadata as Record<string, unknown>;
  const name = skillNameSchema.safeParse(fields.name);
  if (!name.success || name.data !== directoryName) {
    throw new Error("Skill 名称无效或与目录名不一致。");
  }

  if (
    typeof fields.description !== "string" ||
    !fields.description.trim() ||
    fields.description.length > 1024
  ) {
    throw new Error("Skill description 必须是 1–1024 字符的非空字符串。");
  }

  const content = text.slice(end + 5).trim();
  if (!content) {
    throw new Error("Skill 正文不能为空。");
  }

  return { name: name.data, description: fields.description.trim(), content };
}

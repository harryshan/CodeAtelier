/**
 * 校验可提交的 dotenv 模板，避免仅凭 `.env.example` 一类文件名放行真实凭据。
 * GitToolRunner 在 add、commit、diff 和 show 处理受控模板路径时调用本模块；普通文件访问仍由
 * paths.ts 的保守敏感路径规则和 ToolRunner 审批边界负责。
 *
 * 1. validateDotenvTemplate 读取受限大小的普通 UTF-8 文件，拒绝链接、二进制和非模板文件形态。
 * 2. assertNoCredentialMaterial 扫描 dotenv 赋值及常见凭据字面量；安全模板中的敏感变量只能留空或使用
 *    明确占位值，避免将实际密钥送入 Git 索引、历史或工具输出。
 * 3. 校验只提供确定性的提交前保护，不宣称可以识别任意秘密；无法判定为安全的敏感变量值会保守拒绝。
 */

import { lstat, readFile } from "node:fs/promises";

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const secretVariable =
  /(?:^|_)(?:api_?key|access_?key|secret|token|password|passwd|credentials?|private_?key)(?:_|$)/i;
const knownCredentialPatterns: Array<[string, RegExp]> = [
  ["PEM 私钥", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["OpenAI 风格密钥", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/],
  [
    "Bearer token",
    /\bBearer\s+(?!<[^>\r\n]+>|(?:YOUR|REPLACE|EXAMPLE)_[A-Z0-9_]+(?:\s|$))[A-Za-z0-9._~+/-]{12,}/i,
  ],
  ["带密码的 URL", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
];

function templateValue(value: string) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\s+#.*$/, "").trim();
}

function placeholderValue(value: string) {
  return (
    !value ||
    /^<[^>\r\n]+>$/.test(value) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ||
    /^(?:your|replace(?:[-_ ]with)?|example|dummy|test|local|placeholder|change[-_ ]?me)[-_ .:/<>{}A-Za-z0-9]*$/.test(
      value,
    ) ||
    /^[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?|_VALUE|_HERE)$/.test(
      value,
    )
  );
}

function assignmentFromLine(line: string) {
  const text = line.replace(/^(?:[+#-]\s*)+/, "");
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
    text,
  );

  return match && { name: match[1], value: templateValue(match[2]) };
}

export function assertNoCredentialMaterial(content: string) {
  for (const [description, pattern] of knownCredentialPatterns) {
    if (pattern.test(content)) {
      throw new Error(`dotenv 模板包含 ${description}。`);
    }
  }

  for (const line of content.split(/\r?\n/)) {
    const assignment = assignmentFromLine(line);

    if (
      assignment &&
      secretVariable.test(assignment.name) &&
      !placeholderValue(assignment.value)
    ) {
      throw new Error(
        `dotenv 模板的敏感变量 ${assignment.name} 必须为空或使用明确占位值。`,
      );
    }
  }
}

export async function validateDotenvTemplate(file: string) {
  const info = await lstat(file);

  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Git dotenv 模板必须是普通文件，不能是目录或符号链接。");
  }

  if (info.size > MAX_TEMPLATE_BYTES) {
    throw new Error("Git dotenv 模板超过 2 MiB，无法安全校验。");
  }

  const bytes = await readFile(file);
  let content: string;

  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Git dotenv 模板必须使用 UTF-8 文本编码。");
  }

  if (content.includes("\0")) {
    throw new Error("Git dotenv 模板不能包含二进制 NUL 字符。");
  }

  assertNoCredentialMaterial(content);
}

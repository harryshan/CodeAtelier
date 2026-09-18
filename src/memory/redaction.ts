/**
 * 对项目记忆的模型输入、直接编辑内容和序列化前条目执行保守的敏感信息检查。
 * Markdown 解析器和 Mutator 调用本模块；它只返回受控错误类别，不记录或回显被拒绝的正文。
 *
 * 1. 检查常见凭据标记、私钥、Bearer 值、dotenv 赋值和高风险长 token。
 * 2. 检查完整源码或工具输出常见的代码围栏，避免项目记忆成为源码归档旁路。
 * 3. 通过 MemoryValidationError 向上层提供安全、可测试的失败类别，调用方负责日志脱敏和用户提示。
 */

const credentialPatterns: ReadonlyArray<RegExp> = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)\s*[:=]/i,
  /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s#]{8,}/m,
  /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}\b/,
];

const codePatterns: ReadonlyArray<RegExp> = [
  /```/,
  /^\s*(?:import|export|function|class|const|let|var)\s+/m,
];

export class MemoryValidationError extends Error {
  constructor(
    readonly code: "memory_sensitive_content" | "memory_source_invalid",
    message: string,
  ) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

/** 拒绝疑似凭据与代码归档；错误消息不包含原始文本。 */
export function assertSafeMemoryText(...values: string[]) {
  const text = values.join("\n");

  if (credentialPatterns.some((pattern) => pattern.test(text))) {
    throw new MemoryValidationError(
      "memory_sensitive_content",
      "项目记忆不能保存疑似凭据或认证信息。",
    );
  }

  if (codePatterns.some((pattern) => pattern.test(text))) {
    throw new MemoryValidationError(
      "memory_sensitive_content",
      "项目记忆不能保存完整源码或工具输出。",
    );
  }
}

/** 文件事实必须同时携带当前任务观察到的相对路径与字节哈希，或两者都不携带。 */
export function assertCompleteFileSource(
  filePath: string | null,
  fileHash: string | null,
) {
  if ((filePath === null) !== (fileHash === null)) {
    throw new MemoryValidationError(
      "memory_source_invalid",
      "记忆的文件来源必须同时包含相对路径和内容哈希。",
    );
  }
}

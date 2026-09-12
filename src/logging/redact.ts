/**
 * 文件作用：提供不依赖日志运行时的文本和 JSON 凭据脱敏函数。
 * 代码结构：redactText 处理已知密钥和常见凭据形式，redactJson 对结构化内容脱敏并保留可解析的 JSON。
 */

export function redactText(value: string, secrets: string[] = []): string {
  let text = value;

  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join("[REDACTED]");
    }
  }

  return text
    .replace(
      /("(?:api[_-]?key|token|password|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    );
}

/** 在字符串值中脱敏，再序列化；不能用正则修改 JSON 的转义语法。 */
export function redactJson(value: string, secrets: string[] = []): string {
  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      return redactText(item, secrets);
    }

    if (Array.isArray(item)) {
      return item.map(visit);
    }

    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [
          key,
          /^(?:api[_-]?key|token|password|authorization)$/i.test(key)
            ? "[REDACTED]"
            : visit(entry),
        ]),
      );
    }

    return item;
  }

  return JSON.stringify(visit(JSON.parse(value)));
}

/**
 * 从文本和 JSON 中遮盖凭据，供日志、Engine 事件保存和评测报告共用。
 * 输入输出都是字符串，不读写文件，也不依赖日志实例。
 *
 * 1. redactText 先替换调用方给出的密钥，再处理 Bearer 和常见凭据字段。
 * 2. redactJson 解析 JSON，用 visit 递归处理字符串、数组和对象中的敏感值。
 * 3. 重新序列化 JSON，保留合法的引号和转义。
 *
 * redactJson 只接受有效 JSON；不能靠正则直接替换序列化文本，否则可能破坏格式。
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

/** 先解析再遮盖敏感值，最后重新序列化，避免破坏 JSON 转义。 */
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

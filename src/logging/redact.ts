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

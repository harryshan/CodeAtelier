/**
 * 从文本和 JSON 中遮盖凭据，供日志、Engine 事件、trace 和评测报告共用。
 * 输入输出都是字符串，不读写文件，也不依赖日志实例。
 *
 * 1. isCredentialKey 统一识别大小写、分隔符及常见供应商前缀下的凭据字段，不遮盖 token 数量等统计。
 * 2. redactText 先替换已知密钥，再处理整行/带引号认证头、认证 scheme、带引号赋值和长命令选项；替换保留引号边界。
 * 3. redactJson 解析后递归遮盖整项敏感值（包括非字符串和嵌套对象），再序列化以保留合法 JSON。
 *
 * redactJson 只接受有效 JSON；不能靠正则直接替换序列化文本，否则可能破坏格式。
 */

/** 匹配值本身是凭据的字段；inputTokens/tokenCount/tokenizer 等计量字段不会命中。 */
export function isCredentialKey(key: string) {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();

  return (
    /(?:apikey|authorization|cookie|password|passwd|clientsecret|privatekey|secretkey|secretaccesskey|accesskeyid|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken)$/.test(
      normalized,
    ) || /^(?:token|secret|pwd|accesskey)$/.test(normalized)
  );
}

/** 复用原来的引号，避免遮盖命令/源码中的值时留下后半段或破坏诊断文本的边界。 */
function maskedValue(value: string) {
  const quote = value[0];

  return quote === '"' || quote === "'"
    ? `${quote}[REDACTED]${quote}`
    : "[REDACTED]";
}

export function redactText(value: string, secrets: string[] = []): string {
  let text = value;

  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join("[REDACTED]");
    }
  }

  return text
    .replace(
      /^([ \t]*)([A-Za-z][A-Za-z0-9_-]*)([ \t]*:[ \t]*)[^\r\n]*/gm,
      (match, indent: string, key: string, separator: string) =>
        /^(?:proxy[-_]?)?authorization$|^(?:set[-_]?)?cookie$/i.test(key)
          ? `${indent}${key}${separator}[REDACTED]`
          : match,
    )
    .replace(
      /(["'])([A-Za-z][A-Za-z0-9_-]*)(\s*:\s*)((?:\\.|(?!\1)[^\\\r\n])*)\1/g,
      (match, quote: string, key: string, separator: string) =>
        isCredentialKey(key)
          ? `${quote}${key}${separator}[REDACTED]${quote}`
          : match,
    )
    .replace(
      /((?:proxy[-_]?)?authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z_][A-Za-z0-9_-]*)\2(\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'}]+)/g,
      (
        match,
        boundary: string,
        quote: string,
        key: string,
        separator: string,
        value: string,
      ) =>
        isCredentialKey(key)
          ? `${boundary}${quote}${key}${quote}${separator}${maskedValue(value)}`
          : match,
    )
    .replace(
      /(--([A-Za-z_][A-Za-z0-9_-]*)(?:\s*=\s*|\s+))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/g,
      (match, prefix: string, key: string, value: string) =>
        isCredentialKey(key) ? prefix + maskedValue(value) : match,
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
          isCredentialKey(key) ? "[REDACTED]" : visit(entry),
        ]),
      );
    }

    return item;
  }

  return JSON.stringify(visit(JSON.parse(value)));
}

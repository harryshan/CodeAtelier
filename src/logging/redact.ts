/**
 * 文件作用：提供不依赖日志运行时的文本和 JSON 凭据脱敏函数。
 *
 * 模块协作与输入输出：
 * 被日志、Engine 事件保存和评测导出复用，输入文本或 JSON 字符串，返回脱敏后的字符串。
 *
 * 代码结构与执行顺序：
 * 1. redactText 先替换显式 secret，再处理 Bearer、凭据赋值和常见 JSON 字段形式。
 * 2. redactJson 先解析 JSON，通过 visit 递归处理字符串、数组及对象中的敏感键。
 * 3. 最后重新序列化结构，避免正则替换破坏引号和转义。
 *
 * 关键约束：
 * 这是纯转换模块，无文件或日志副作用；redactJson 要求输入有效 JSON，不能用它解析任意源码。
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

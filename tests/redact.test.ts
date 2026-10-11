/**
 * 验证日志、历史和 trace 共用的纯脱敏函数，不接触真实凭据或外部服务。
 * 1. 文本矩阵覆盖常见字段别名、引号/转义、命令选项与完整认证头，重复脱敏保持稳定。
 * 2. JSON 用例覆盖数字、布尔、数组及对象型凭据，确保序列化合法且普通参数/计数不丢失。
 * 这些断言检查输出中原假值是否消失及非敏感内容是否保留，不依赖正则的具体实现。
 */

import { expect, it } from "vitest";
import { redactJson, redactText } from "../src/logging/redact.js";

it.each([
  'access_token="FAKE value with spaces"',
  "const refreshToken = 'FAKE value';",
  '{"client_secret":"FAKE\\\"value"}',
  "OPENAI_API_KEY=FAKE_VALUE",
  "AWS_SECRET_ACCESS_KEY=FAKE_VALUE",
  "secret_key=FAKE_VALUE",
  "curl --password 'FAKE value' --verbose",
  'curl --access-token="FAKE value" --verbose',
  "curl -H 'Authorization: Basic FAKE_VALUE'",
  "curl -H 'Cookie: session=FAKE_ONE; auth=FAKE_TWO'",
  'curl -H "X-Api-Key: FAKE_VALUE"',
])("redacts credential text and preserves unrelated suffixes: %s", (source) => {
  const redacted = redactText(source + " path=src/main.ts tokenCount=7");

  expect(redacted).not.toContain("FAKE");
  expect(redacted).toContain("path=src/main.ts tokenCount=7");
  expect(redactText(redacted)).toBe(redacted);
});

it("redacts entire JSON credential values of every type and preserves normal diagnostics", () => {
  const result = JSON.parse(
    redactJson(
      JSON.stringify({
        password: 123456,
        token: false,
        headers: {
          "Set-Cookie": ["FAKE_ONE", "FAKE_TWO"],
          "X-Api-Key": "FAKE_KEY",
        },
        clientSecret: { nested: "FAKE_SECRET" },
        entries: [{ refresh_token: "FAKE_TOKEN", id: "entry-1" }],
        inputTokens: 42,
        tokenCount: 7,
        tokenizer: "fixture",
        path: "src/main.ts",
      }),
    ),
  );

  expect(JSON.stringify(result)).not.toContain("FAKE");
  expect(result).toMatchObject({
    password: "[REDACTED]",
    token: "[REDACTED]",
    clientSecret: "[REDACTED]",
    inputTokens: 42,
    tokenCount: 7,
    tokenizer: "fixture",
    path: "src/main.ts",
    entries: [{ refresh_token: "[REDACTED]", id: "entry-1" }],
  });
});

it("redacts complete raw HTTP credential headers and keeps the next diagnostic line", () => {
  const source =
    "Cookie: session=FAKE_ONE; auth=FAKE_TWO\nAuthorization: Digest username=FAKE_USER, response=FAKE_RESPONSE\npath=src/main.ts";
  const result = redactText(source);

  expect(result).not.toContain("FAKE");
  expect(result).toContain("\npath=src/main.ts");
  expect(redactText(result)).toBe(result);
});

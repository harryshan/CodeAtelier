/**
 * 文件作用：配置项目 TypeScript 的静态规则和基础可读性约束。
 * 代码结构：先引入 TypeScript ESLint，再组合忽略目录、推荐规则与花括号、变量声明和段落间距规则。
 */

import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      curly: ["error", "all"],
      "one-var": ["error", "never"],
      "lines-between-class-members": [
        "error",
        "always",
        { exceptAfterSingleLine: true },
      ],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "never", prev: "import", next: "import" },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "return" },
      ],
    },
  },
);

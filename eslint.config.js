/**
 * 配置 pnpm lint 和 check 使用的 TypeScript ESLint 规则。
 *
 * 1. 跳过依赖与构建目录，加载推荐规则。
 * 2. 允许动态协议代码使用 any，要求条件加花括号、每次只声明一个变量。
 * 3. 设置类成员和语句之间的空行规则，让不同步骤容易分辨。
 *
 * 工具只能检查排版等固定规则，注释是否准确、代码是否易读仍需人工审核。
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

/**
 * 文件作用：配置项目 TypeScript 的静态规则和基础可读性约束。
 *
 * 使用场景与输入输出：
 * 由 pnpm lint/check 使用，在 TypeScript ESLint 推荐规则上落实项目可读性约定。
 *
 * 代码结构与阅读顺序：
 * 1. 先忽略依赖和构建目录，再展开推荐配置。
 * 2. 项目规则允许既有动态协议 any，同时强制条件花括号和单变量声明。
 * 3. 类成员与语句段落规则约束导入、块和返回前后的空行。
 *
 * 维护注意事项：
 * 静态规则不能判断文件职责说明是否准确，提交仍需人工核对导读与实现。
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

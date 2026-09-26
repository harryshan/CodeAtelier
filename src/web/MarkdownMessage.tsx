/**
 * 将会话中的用户和 agent 文本安全地转换为 Markdown 内容，供 Timeline 的已保存消息和流式消息共用。
 * 输入是后端持久化或 SSE 推送的普通文本，输出仅为 React 元素；本组件不解析 HTML、不会写入状态，也不访问会话或网络。
 *
 * 1. MarkdownMessage 配置 react-markdown 与 remark-gfm，覆盖标题、列表、表格、任务列表、删除线和代码围栏等常见编码回复格式。
 * 2. skipHtml 明确丢弃回复中混入的原始 HTML。Markdown 链接仍由库的默认安全 URL 转换处理，避免把模型或用户文本作为可执行页面内容。
 * 3. memo 按 text 复用 Markdown 渲染；滚动、时钟及其它卡片更新不重新解析相同正文。
 * 4. 外层 prose 样式由 app.module.css 统一控制段落、代码、表格和引用的可读性；调用方不需要了解解析器细节。
 */

import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import s from "./app.module.css";

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
}: {
  text: string;
}) {
  return (
    <div className={s.prose}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </Markdown>
    </div>
  );
});

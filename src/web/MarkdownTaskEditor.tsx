/**
 * 任务输入区的所见即所得 Markdown 编辑器，供 App 在选中会话时编辑并提交下一条用户指令。
 * 它用 Tiptap 的受限文档 schema 将输入规则形成的标题、强调、列表、引用和代码块直接显示为富文本，
 * 并通过 Markdown 扩展把编辑器文档序列化回 Markdown，交给 App 作为后端 prompt。
 *
 * 1. MarkdownTaskEditor 接收 App 持有的 Markdown 值、更新回调和发送回调；不访问 API、会话或持久化层。
 * 2. useEditor 组合 StarterKit 与 Markdown。编辑器的 onUpdate 只输出 getMarkdown()，因此富文本 DOM 不会作为 HTML 提交给模型。
 * 3. 两个 ref 始终指向最新回调，避免 Tiptap 创建后保留旧的 React 闭包；Enter 发送、Shift+Enter 换行和输入法组合输入沿用原输入框语义。
 * 4. 当 App 在发送或恢复成功后清空值时，effect 清空编辑器文档。除此以外不从外部重置内容，避免打断正在输入的光标和撤销历史。
 *
 * 编辑器只使用 Tiptap 已注册的节点和 mark，Markdown 中的原始 HTML 不会作为任意页面 HTML 提交或渲染。
 */

import { useEffect, useRef } from "react";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import s from "./app.module.css";

type MarkdownTaskEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
};

export function MarkdownTaskEditor({
  value,
  onChange,
  onSubmit,
}: MarkdownTaskEditorProps) {
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
  }, [onChange, onSubmit]);

  const editor = useEditor(
    {
      extensions: [StarterKit, Markdown],
      content: value,
      contentType: "markdown",
      editorProps: {
        attributes: {
          "aria-label": "任务描述",
          "aria-multiline": "true",
          class: `${s.richComposerEditor} ${s.prose}`,
          role: "textbox",
        },
        handleKeyDown: (_view, event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            onSubmitRef.current();

            return true;
          }

          return false;
        },
      },
      onUpdate: ({ editor: updatedEditor }) => {
        onChangeRef.current(updatedEditor.getMarkdown());
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor || value || editor.isEmpty) {
      return;
    }

    editor.commands.clearContent();
  }, [editor, value]);

  return <EditorContent editor={editor} />;
}

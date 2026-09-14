/**
 * 为 FileEditor 计算原始文本上的精确修改，不读取文件、不写盘，也不授予权限。
 * 1. TextEdit/FileEdit 是 registry 校验后的内部参数；行号为 null 时使用唯一文本匹配。
 * 2. planEdits 在指定行范围或全文中唯一匹配旧文本，转换为原始快照字符区间，拒绝错配和重叠。
 * 3. 从后向前应用已定位区间，保持其他区间坐标与未修改的换行符不变，返回完整新文本。
 * 行范围包含首尾行及末行换行符；只替换实际匹配片段，CRLF 必须精确匹配，不向范围外回退。
 */

export interface TextEdit {
  oldText: string;
  newText: string;
  startLine: number | null;
  endLine: number | null;
}

export interface FileEdit {
  path: string;
  edits: TextEdit[];
}

export function planEdits(before: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let index = 0; index < before.length; index++) {
    if (before[index] === "\n") {
      starts.push(index + 1);
    }
  }

  const ranges = edits
    .map((edit, index) => {
      let start: number;
      let end: number;
      const fail = (message: string): never => {
        throw new Error(`第 ${index + 1} 项：${message}`);
      };

      if (edit.startLine === null && edit.endLine === null) {
        start = before.indexOf(edit.oldText);
        if (start < 0 || before.indexOf(edit.oldText, start + 1) >= 0) {
          fail("oldText 必须在文件中精确匹配一次。");
        }

        end = start + edit.oldText.length;
      } else {
        if (edit.startLine === null || edit.endLine === null) {
          return fail("startLine 和 endLine 必须同时提供或同时为 null。");
        }

        if (edit.endLine < edit.startLine || edit.endLine > starts.length) {
          return fail("行号范围无效或超出文件。");
        }

        const rangeStart = starts[edit.startLine - 1];
        const rangeEnd =
          edit.endLine < starts.length ? starts[edit.endLine] : before.length;
        const scope = before.slice(rangeStart, rangeEnd);
        const match = scope.indexOf(edit.oldText);
        if (match < 0) {
          fail(
            `第 ${edit.startLine}-${edit.endLine} 行内未找到精确匹配的 oldText；请核对行号和原文（包括换行符）。`,
          );
        }

        if (scope.indexOf(edit.oldText, match + 1) >= 0) {
          fail(
            `第 ${edit.startLine}-${edit.endLine} 行内 oldText 匹配不唯一，请缩小范围或增加上下文。`,
          );
        }

        // 行号只限定搜索窗口；重叠检查与替换使用实际匹配片段的坐标。
        start = rangeStart + match;
        end = start + edit.oldText.length;
      }

      return { start, end, replacement: edit.newText };
    })
    .sort((a, b) => a.start - b.start);

  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error("修改范围重叠，请合并同一区域的修改。");
    }
  }

  let after = before;
  for (const range of ranges.reverse()) {
    after =
      after.slice(0, range.start) + range.replacement + after.slice(range.end);
  }

  return after;
}

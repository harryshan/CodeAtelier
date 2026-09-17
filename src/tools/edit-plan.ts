/**
 * 为 FileEditor 在原始文本快照上规划可验证的补丁，不读取文件、不写盘，也不授予权限。
 * 1. TextEdit、ExistingFileEdit 和 NewFile 是 registry 校验后的内部参数；已有文件携带读取时的版本和可选上下文锚点，新文件只提供完整正文。
 * 2. planEdits 先在行范围或全文进行精确匹配；仅在精确匹配不存在时，才在同一范围内用空白规范化定位唯一候选，并保留真实原文坐标。
 * 3. EditPlanError 将未找到、歧义、锚点不符及空白敏感文件拒绝转换为模型可修复的结构化诊断；不确定时绝不选择候选。
 * 4. 从后向前应用已定位区间，保持其他区间坐标和文件原有换行风格不变，返回完整新文本及每项实际匹配方式。
 * 行范围包含首尾行及末行换行符；规范化只用于定位，写入始终替换真实快照片段，且不能越过搜索窗口。
 */

export interface TextEdit {
  oldText: string;
  newText: string;
  startLine: number | null;
  endLine: number | null;
  beforeContext: string | null;
  afterContext: string | null;
}

export interface ExistingFileEdit {
  path: string;
  create: false;
  fileVersion: string | null;
  edits: TextEdit[];
}

export interface NewFile {
  path: string;
  create: true;
  content: string;
}

export type FileEdit = ExistingFileEdit | NewFile;
export type EditMatchMode = "exact" | "normalized_whitespace";

export interface EditDiagnostic {
  code:
    | "EDIT_TARGET_NOT_FOUND"
    | "EDIT_TARGET_AMBIGUOUS"
    | "EDIT_CONTEXT_MISMATCH"
    | "EDIT_WHITESPACE_FALLBACK_DISALLOWED"
    | "EDIT_FILE_VERSION_MISMATCH"
    | "EDIT_OVERLAPPING_RANGES";
  message: string;
  lineRange: [number, number] | null;
  expectedDisplay: string;
  candidateLines?: number[];
  suggestedAction: string;
}

export class EditPlanError extends Error {
  constructor(readonly diagnostic: EditDiagnostic) {
    super(diagnostic.message);
    this.name = "EditPlanError";
  }
}

interface MatchRange {
  start: number;
  end: number;
}

interface NormalizedText {
  value: string;
  starts: number[];
  ends: number[];
}

export interface PlannedEdits {
  after: string;
  matchModes: EditMatchMode[];
}

export interface EditPlanningOptions {
  allowWhitespaceFallback: boolean;
}

export function displayWhitespace(value: string) {
  return value
    .replaceAll("\r", "␍")
    .replaceAll("\n", "↵\n")
    .replaceAll("\t", "→")
    .replaceAll(" ", "·");
}

function lineStarts(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
}

function lineForOffset(starts: number[], offset: number) {
  let line = 1;
  for (let index = 1; index < starts.length; index++) {
    if (starts[index] > offset) {
      break;
    }

    line = index + 1;
  }

  return line;
}

function allExactMatches(
  text: string,
  target: string,
  offset: number,
): MatchRange[] {
  const matches: MatchRange[] = [];
  let start = text.indexOf(target);
  while (start >= 0) {
    matches.push({
      start: offset + start,
      end: offset + start + target.length,
    });
    start = text.indexOf(target, start + 1);
  }

  return matches;
}

function normalizeWhitespace(text: string): NormalizedText {
  let value = "";
  const starts: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < text.length; index++) {
    if (/\s/u.test(text[index])) {
      continue;
    }

    value += text[index];
    starts.push(index);
    ends.push(index + 1);
  }

  return { value, starts, ends };
}

function allNormalizedMatches(
  text: string,
  target: string,
  offset: number,
): MatchRange[] {
  const normalizedText = normalizeWhitespace(text);
  const normalizedTarget = normalizeWhitespace(target).value;
  if (!normalizedTarget) {
    return [];
  }

  const matches: MatchRange[] = [];
  let match = normalizedText.value.indexOf(normalizedTarget);

  while (match >= 0) {
    const endIndex = match + normalizedTarget.length - 1;
    matches.push({
      start: offset + normalizedText.starts[match],
      end: offset + normalizedText.ends[endIndex],
    });
    match = normalizedText.value.indexOf(normalizedTarget, match + 1);
  }

  return matches;
}

function matchesContext(before: string, range: MatchRange, edit: TextEdit) {
  return (
    (edit.beforeContext === null ||
      before.slice(0, range.start).endsWith(edit.beforeContext)) &&
    (edit.afterContext === null ||
      before.slice(range.end).startsWith(edit.afterContext))
  );
}

function diagnostic(
  code: EditDiagnostic["code"],
  message: string,
  edit: TextEdit,
  candidateLines: number[] | undefined,
): EditPlanError {
  return new EditPlanError({
    code,
    message,
    lineRange:
      edit.startLine === null || edit.endLine === null
        ? null
        : [edit.startLine, edit.endLine],
    expectedDisplay: displayWhitespace(edit.oldText),
    candidateLines,
    suggestedAction:
      "重新读取候选行（whitespaceMode:true 可显示不可见字符），缩小行范围或补充稳定上下文后再编辑。",
  });
}

function searchScope(before: string, edit: TextEdit, starts: number[]) {
  if (edit.startLine === null && edit.endLine === null) {
    return { start: 0, end: before.length };
  }

  if (edit.startLine === null || edit.endLine === null) {
    throw new Error("startLine 和 endLine 必须同时提供或同时为 null。");
  }

  if (edit.endLine < edit.startLine || edit.endLine > starts.length) {
    throw new Error("行号范围无效或超出文件。");
  }

  return {
    start: starts[edit.startLine - 1],
    end: edit.endLine < starts.length ? starts[edit.endLine] : before.length,
  };
}

function selectUniqueMatch(
  before: string,
  edit: TextEdit,
  index: number,
  starts: number[],
  allowWhitespaceFallback: boolean,
): { range: MatchRange; matchMode: EditMatchMode } {
  const scope = searchScope(before, edit, starts);
  const scopedText = before.slice(scope.start, scope.end);
  const lineNumbers = (matches: MatchRange[]) =>
    matches.map((match) => lineForOffset(starts, match.start));
  const exact = allExactMatches(scopedText, edit.oldText, scope.start).filter(
    (match) => matchesContext(before, match, edit),
  );

  if (exact.length === 1) {
    return { range: exact[0], matchMode: "exact" };
  }

  if (exact.length > 1) {
    throw diagnostic(
      "EDIT_TARGET_AMBIGUOUS",
      `第 ${index + 1} 项：oldText 必须在文件中精确匹配一次；当前精确匹配不唯一。`,
      edit,
      lineNumbers(exact),
    );
  }

  const rawExact = allExactMatches(scopedText, edit.oldText, scope.start);
  if (rawExact.length > 0) {
    throw diagnostic(
      "EDIT_CONTEXT_MISMATCH",
      `第 ${index + 1} 项：oldText 已找到，但不满足提供的上下文锚点。`,
      edit,
      lineNumbers(rawExact),
    );
  }

  const normalized = allNormalizedMatches(
    scopedText,
    edit.oldText,
    scope.start,
  ).filter((match) => matchesContext(before, match, edit));
  if (!normalized.length) {
    throw diagnostic(
      "EDIT_TARGET_NOT_FOUND",
      `第 ${index + 1} 项：oldText 必须在文件中精确匹配一次；精确和空白规范化匹配均无唯一候选。`,
      edit,
      undefined,
    );
  }

  if (normalized.length > 1) {
    throw diagnostic(
      "EDIT_TARGET_AMBIGUOUS",
      `第 ${index + 1} 项：空白规范化后存在多个候选，已拒绝猜测。`,
      edit,
      lineNumbers(normalized),
    );
  }

  if (!allowWhitespaceFallback) {
    throw diagnostic(
      "EDIT_WHITESPACE_FALLBACK_DISALLOWED",
      `第 ${index + 1} 项：该空白敏感文件只接受精确匹配。`,
      edit,
      lineNumbers(normalized),
    );
  }

  return { range: normalized[0], matchMode: "normalized_whitespace" };
}

export function planEdits(
  before: string,
  edits: TextEdit[],
  options: EditPlanningOptions,
): PlannedEdits {
  const starts = lineStarts(before);
  const ranges = edits
    .map((edit, index) => {
      const match = selectUniqueMatch(
        before,
        edit,
        index,
        starts,
        options.allowWhitespaceFallback,
      );

      return {
        ...match.range,
        replacement: edit.newText,
        matchMode: match.matchMode,
      };
    })
    .sort((left, right) => left.start - right.start);

  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new EditPlanError({
        code: "EDIT_OVERLAPPING_RANGES",
        message: "修改范围重叠，请合并同一区域的修改。",
        lineRange: null,
        expectedDisplay: "",
        suggestedAction: "合并重叠修改后重新提交。",
      });
    }
  }

  let after = before;
  for (const range of [...ranges].reverse()) {
    after =
      after.slice(0, range.start) + range.replacement + after.slice(range.end);
  }

  return { after, matchModes: ranges.map((range) => range.matchMode) };
}

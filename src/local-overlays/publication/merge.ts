/**
 * Local overlay 发布的纯内容整合器，供生产 Publisher 与回归测试调用。
 * 1. mergeContent 先处理相等、存在/删除和单方变化，不依赖 Git 或文件系统。
 * 2. changes 用现有 diff 库产生有界行修改，保留原换行和 EOF；不忽略空白。
 * 3. 双方修改只合并互不重叠的行区间；同点插入、边界歧义、二进制双改保守冲突。
 * 返回新 Buffer 或 null（删除）；不产生冲突标记、不猜测语义正确性、不写盘。
 */
import { diffLines } from "diff";

export const MAX_BYTES = 2 * 1024 * 1024;

export class PublishError extends Error {
  constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export function equal(left: Buffer | null, right: Buffer | null) {
  return left === null ? right === null : right !== null && left.equals(right);
}

interface Change {
  start: number;
  end: number;
  text: string;
}

function text(bytes: Buffer) {
  if (bytes.length > MAX_BYTES || bytes.includes(0)) {
    throw new PublishError("UNMERGEABLE_CONTENT");
  }

  try {
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (value.split("\n").length > 20_000) {
      throw new PublishError("MERGE_LIMIT");
    }

    return value;
  } catch (error) {
    if (error instanceof PublishError) {
      throw error;
    }

    throw new PublishError("UNMERGEABLE_CONTENT");
  }
}

function changes(base: string, result: string) {
  const parts = diffLines(base, result, { maxEditLength: 2000, timeout: 100 });
  if (!parts) {
    throw new PublishError("MERGE_LIMIT");
  }

  const output: Change[] = [];
  let position = 0;
  let current: Change | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      current = undefined;
      position += part.count;
      continue;
    }

    if (!current) {
      current = { start: position, end: position, text: "" };
      output.push(current);
    }

    if (part.removed) {
      position += part.count;
      current.end = position;
    } else {
      current.text += part.value;
    }
  }

  return output;
}

function overlaps(left: Change, right: Change) {
  if (left.start === left.end || right.start === right.end) {
    return left.start <= right.end && right.start <= left.end;
  }

  return left.start < right.end && right.start < left.end;
}

export function mergeContent(
  base: Buffer | null,
  ours: Buffer | null,
  theirs: Buffer | null,
) {
  for (const bytes of [base, ours, theirs]) {
    if (bytes && bytes.length > MAX_BYTES) {
      throw new PublishError("FILE_LIMIT");
    }
  }

  if (equal(ours, base) || equal(ours, theirs)) {
    return theirs === null ? null : Buffer.from(theirs);
  }

  if (equal(theirs, base)) {
    return ours === null ? null : Buffer.from(ours);
  }

  if (base === null || ours === null || theirs === null) {
    throw new PublishError("EXISTENCE_CONFLICT");
  }

  const original = text(base);
  const edits = changes(original, text(ours));
  for (const candidate of changes(original, text(theirs))) {
    let identical = false;
    for (const edit of edits) {
      if (
        edit.start === candidate.start &&
        edit.end === candidate.end &&
        edit.text === candidate.text
      ) {
        identical = true;
      } else if (overlaps(edit, candidate)) {
        throw new PublishError("TEXT_CONFLICT");
      }
    }

    if (!identical) {
      edits.push(candidate);
    }
  }

  edits.sort((left, right) => left.start - right.start);
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let position = 0;
  let merged = "";
  for (const edit of edits) {
    merged += lines.slice(position, edit.start).join("") + edit.text;
    position = edit.end;
  }

  const result = Buffer.from(merged + lines.slice(position).join(""));
  if (result.length > MAX_BYTES) {
    throw new PublishError("FILE_LIMIT");
  }

  return result;
}

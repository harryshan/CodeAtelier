/**
 * 为 ToolRunner 在异步读取结束后直接计算文件内容，不创建线程或执行文件系统操作。
 * 输入是已经通过路径、权限、文件类型和大小检查的字节及已校验的行范围；输出全文字节哈希、分页元数据和显示文本。
 *
 * 1. ReadFileTrace 定义检查、读取、同步计算三个阶段，供宿主 Engine 与 Runtime 关联调用并记录终态。
 * 2. visibleWhitespace/totalLines/selectedLines 扫描字节、拒绝空字节，仅解码请求的行，保留 CRLF 和末尾空行语义。
 * 3. processReadFile 生成 SHA-256 与显示结果；不保存读取凭证，凭证由 ToolRunner 在成功且未取消后登记。
 * 同步计算期间不让出事件循环；取消在调用前后检查，不声称可中断正在执行的扫描。
 */

import { createHash } from "node:crypto";

export type ReadFileTraceStage =
  "read_file.stat" | "read_file.bytes" | "read_file.compute";

export type ReadFileTrace = (
  stage: ReadFileTraceStage,
  state: "started" | "ok" | "error" | "cancelled",
  details?: { bytes?: number; computeMs?: number },
) => void;

interface ReadFileOptions {
  startLine: number;
  endLine: number;
  maxLines: number;
  whitespaceMode: boolean;
}

function visibleWhitespace(line: string) {
  return (
    line.replaceAll("\r", "␍").replaceAll("\t", "→").replaceAll(" ", "·") + "↵"
  );
}

function totalLines(bytes: Uint8Array) {
  let lines = 1;

  for (const byte of bytes) {
    if (byte === 0) {
      throw new Error("不支持二进制文件");
    }

    if (byte === 0x0a) {
      lines += 1;
    }
  }

  return lines;
}

function selectedLines(
  bytes: Uint8Array,
  startLine: number,
  returnedEndLine: number,
): string[] {
  if (returnedEndLine < startLine) {
    return [];
  }

  const decoder = new TextDecoder("utf-8");
  const lines: string[] = [];
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index !== bytes.byteLength && bytes[index] !== 0x0a) {
      continue;
    }

    if (lineNumber >= startLine && lineNumber <= returnedEndLine) {
      lines.push(decoder.decode(bytes.subarray(lineStart, index)));
    }

    if (lineNumber === returnedEndLine || index === bytes.byteLength) {
      break;
    }

    lineStart = index + 1;
    lineNumber += 1;
  }

  return lines;
}

export function processReadFile(bytes: Uint8Array, options: ReadFileOptions) {
  const count = totalLines(bytes);
  const requestedEndLine = Math.min(options.endLine, count);
  const returnedEndLine = Math.min(
    requestedEndLine,
    options.startLine + options.maxLines - 1,
  );
  const lines = selectedLines(bytes, options.startLine, returnedEndLine);
  const format = (line: string, index: number) =>
    `${options.startLine + index}: ${line}`;

  return {
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    totalLines: count,
    returnedEndLine,
    truncated: returnedEndLine < requestedEndLine,
    hasMore: returnedEndLine < count,
    nextStartLine: returnedEndLine < count ? returnedEndLine + 1 : null,
    text: lines.map(format).join("\n"),
    visibleText: options.whitespaceMode
      ? lines
          .map((line, index) => format(visibleWhitespace(line), index))
          .join("\n")
      : undefined,
  };
}

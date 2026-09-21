/**
 * 在受限 Worker 线程中处理已读取的文件字节，避免多个 read_file 调用在主事件循环中争抢解码、哈希和行扫描时间。
 * ReadFileWorkerPool 只会把主线程已经完成路径、权限、类型和大小校验后的 ArrayBuffer 传入；本文件不接收路径、不访问文件系统，
 * 因而不能绕过 ToolRunner 的访问控制。Worker 返回完整字节 SHA-256、总行数及最多 500 行的显示文本，主线程再把哈希作为编辑凭证保存。
 *
 * 1. ReadRequest / ReadResult 固定跨线程消息契约，只传递字节和经过 Zod 校验的读取范围。
 * 2. processRead 按字节查找 LF，保留旧实现对空文件、末尾换行和 CRLF 的 totalLines 与文本语义，但不创建整文件行数组。
 * 3. parentPort 仅分发 read 请求，并把受控错误返回给池客户端；没有文件、网络、会话或数据库副作用。
 */

import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

interface ReadRequest {
  id: number;
  type: "read";
  data: {
    bytes: ArrayBuffer;
    startLine: number;
    endLine: number;
    maxLines: number;
    whitespaceMode: boolean;
  };
}

interface ReadResult {
  contentHash: string;
  totalLines: number;
  returnedEndLine: number;
  truncated: boolean;
  hasMore: boolean;
  nextStartLine: number | null;
  text: string;
  visibleText?: string;
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

function processRead(data: ReadRequest["data"]): ReadResult {
  const bytes = new Uint8Array(data.bytes);
  const count = totalLines(bytes);
  const requestedEndLine = Math.min(data.endLine, count);
  const returnedEndLine = Math.min(
    requestedEndLine,
    data.startLine + data.maxLines - 1,
  );
  const lines = selectedLines(bytes, data.startLine, returnedEndLine);
  const format = (line: string, index: number) =>
    `${data.startLine + index}: ${line}`;

  return {
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    totalLines: count,
    returnedEndLine,
    truncated: returnedEndLine < requestedEndLine,
    hasMore: returnedEndLine < count,
    nextStartLine: returnedEndLine < count ? returnedEndLine + 1 : null,
    text: lines.map(format).join("\n"),
    visibleText: data.whitespaceMode
      ? lines
          .map((line, index) => format(visibleWhitespace(line), index))
          .join("\n")
      : undefined,
  };
}

parentPort?.on("message", (message: ReadRequest) => {
  try {
    if (
      message?.type !== "read" ||
      !(message.data?.bytes instanceof ArrayBuffer)
    ) {
      throw new Error("读取 Worker 收到无效请求。");
    }

    parentPort?.postMessage({
      id: message.id,
      ok: true,
      value: processRead(message.data),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: message?.id,
      ok: false,
      error: error instanceof Error ? error.message : "读取 Worker 执行失败。",
    });
  }
});

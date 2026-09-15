/**
 * 第二级按工具契约缩短旧结果正文，保留调用参数、执行状态和快照回读来源。
 * ContextManager 在文件归档后调用 projectToolResults，再统一验收收益、保存完整快照。
 *
 * 1. shrinkResult 对旧会话的 search 记录只去掉命中正文；list_files 留首尾目录条目，
 *    run_command 和只读 Git 输出留诊断摘录，旧写入结果只缩短 diff。它们均不属于当前工具定义。
 * 2. shrinkDiff 仅改字符串 diff；批次 files 的路径、状态、错误以及未知字段原样保留。
 * 3. projectToolResults 核对持久化来源、跳过未知格式/已有投影，用指纹标记被省略字段。
 *
 * 不调用模型或重跑工具，不从正文推断成功；非零退出码、截断和部分成功也可归档正文，
 * 但其元数据必须保留。Git 写操作输出包含结果标识，完整保留。短结果无收益时跳过。
 */

import { createHash } from "node:crypto";
import type { Event } from "../shared/types.js";
import { previewOutput, savedToolResult } from "./tool-result.js";

interface Projection {
  value: Record<string, any>;
  fields: string[];
}

function shrinkResult(
  name: string,
  args: any,
  result: any,
): Projection | undefined {
  if (name === "list_files") {
    // 旧目录工具返回数组；只声称原结果中的数量，不推断磁盘上还有多少条目。
    if (
      !Array.isArray(result) ||
      result.length <= 40 ||
      !result.every(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          typeof entry.type === "string",
      )
    ) {
      return undefined;
    }

    return {
      value: {
        entries: [...result.slice(0, 20), ...result.slice(-20)],
        originalEntryCount: result.length,
        omittedEntryCount: result.length - 40,
      },
      fields: ["entries"],
    };
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }

  // search 已不再公开给新模型；保留旧会话归档和快照回读的兼容性。
  if (
    name === "search" &&
    Array.isArray(result.matches) &&
    result.matches.every(
      (match: any) =>
        match &&
        typeof match.path === "string" &&
        (match.text === undefined || typeof match.text === "string"),
    )
  ) {
    const matches = result.matches.map((match: any) => {
      const location = { ...match };
      delete location.text;

      return location;
    });

    return { value: { ...result, matches }, fields: ["matches[].text"] };
  }

  if (
    name === "run_command" ||
    (name === "git" &&
      ["status", "diff", "log", "show", "branch"].includes(
        (args.request ?? args).action,
      ))
  ) {
    // 没有明确退出码的历史记录保持原样；不能把缺失状态当成正常完成。
    if (
      typeof result.output !== "string" ||
      result.output.length < 2000 ||
      !Number.isSafeInteger(result.exitCode)
    ) {
      return undefined;
    }

    return {
      value: { ...result, output: previewOutput(result.output) },
      fields: ["output"],
    };
  }

  if (name === "write_file" || name === "edit_file") {
    const value = shrinkDiff(result);

    return value === result ? undefined : { value, fields: ["diff"] };
  }

  if (name === "edit_files" && Array.isArray(result.files)) {
    const fields: string[] = [];
    const files = result.files.map((file: any, index: number) => {
      if (!file || typeof file !== "object" || typeof file.path !== "string") {
        return file;
      }

      const next = shrinkDiff(file);
      if (next !== file) {
        fields.push(`files[${index}].diff`);
      }

      return next;
    });

    return fields.length ? { value: { ...result, files }, fields } : undefined;
  }

  return undefined;
}

/** 只处理历史契约中实际存在的 diff，不给当前 edit_files 结果人为添加 diff。 */
function shrinkDiff(result: Record<string, any>) {
  if (typeof result.diff !== "string" || result.diff.length < 2000) {
    return result;
  }

  return { ...result, diff: previewOutput(result.diff) };
}

export function projectToolResults(
  source: any[],
  snapshotId: string,
  events: Event[],
): any[] {
  return source.map((item, index) => {
    const saved = savedToolResult(source, item, events);
    if (
      !saved ||
      !saved.result ||
      saved.result.contextArchive ||
      saved.result.contextEncoding
    ) {
      return item;
    }

    let args: any;
    try {
      args = JSON.parse(saved.call.arguments);
    } catch {
      return item;
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return item;
    }

    const projection = shrinkResult(saved.call.name, args, saved.result);
    if (!projection) {
      return item;
    }

    const output = JSON.stringify({
      ...projection.value,
      contextArchive: {
        snapshotId,
        index,
        offset: 0,
        sha256: createHash("sha256")
          .update(
            JSON.stringify([
              saved.call.name,
              saved.call.arguments,
              item.output,
            ]),
          )
          .digest("hex"),
        omitted: true,
        fields: projection.fields,
        note: "工具历史正文已摘录或省略；调用参数与执行状态保留，不代表操作成功或当前文件状态。使用 read_context_history 回读已保存原文；原输出的截断仍有效，不可据此重放操作。",
      },
    });

    return output.length < item.output.length ? { ...item, output } : item;
  });
}

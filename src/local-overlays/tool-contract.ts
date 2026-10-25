/**
 * Local 发布选择的模型与 IPC 共用契约，由 registry、Runtime 和 Engine 使用。
 * 1. select 仅登记当前任务的相对源码路径及有序候选验证命令，不接受 workspace、任务身份或权限覆盖。
 * 2. clear 撤销本轮选择，不删除私有文件或重放发布；成功收尾才由 Broker 执行验证与发布。
 * 3. 这里只做有界结构校验；路径、来源身份、活动任务与实际 Sandbox 模式由服务再次核对。
 * 返回值明确 published:false，不能将登记回执当作来源已更新。普通 Local/Worktree 与子任务不开放此工具。
 */
import { z } from "zod";

export const localPublicationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("select"),
      paths: z.array(z.string().min(1).max(32_767)).min(1).max(100),
      commands: z.array(z.string().trim().min(1).max(32_000)).min(1).max(8),
    })
    .strict(),
  z.object({ action: z.literal("clear") }).strict(),
]);

export const localPublicationToolSchema = z
  .object({
    request: localPublicationRequestSchema,
  })
  .strict();

export type LocalPublicationRequest = z.infer<
  typeof localPublicationRequestSchema
>;
export interface LocalPublicationResult {
  selected: number;
  published: false;
}

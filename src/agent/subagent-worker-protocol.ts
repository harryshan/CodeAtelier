/*
 * 定义单个 subagent Worker 与任务所在主进程的消息协议，供 Worker 与协调器共同使用。
 *
 * 1. SubagentWorkerInput 只携带已绑定 taskId、角色、任务与读取范围，不传模型密钥或写入能力。
 * 2. 每条 request/response/message/finish/stop 带固定版本、任务/子身份和逐方向序号；question 请求关联独立持久化回执。
 * 3. message 可关联已保存问题的 replyTo，在下一轮追加主代理回复；finish 与 stop 分别是终态提议和取消通知。
 *
 * 类型不构成运行时验证；双方在读取 Worker 消息时必须核对版本、归属和序号。
 */

export const SUBAGENT_WORKER_PROTOCOL_VERSION = 3;

export interface SubagentMessageEnvelope {
  version: typeof SUBAGENT_WORKER_PROTOCOL_VERSION;
  taskId: string;
  subagentId: string;
  sequence: number;
}

export interface SubagentWorkerInput {
  taskId: string;
  id: string;
  role: string;
  objective: string;
  scope: string[];
  deliverable: string;
}

export type SubagentWorkerRequest = SubagentMessageEnvelope & {
  kind: "request";
  id: number;
  operation: "model" | "read" | "checkpoint" | "question";
  payload: unknown;
};

export type SubagentWorkerMessage =
  | SubagentWorkerRequest
  | (SubagentMessageEnvelope & {
      kind: "finish";
      status: "completed" | "failed" | "cancelled";
      report: string;
      context: unknown[];
    });

export type SubagentParentMessage =
  | (SubagentMessageEnvelope & {
      kind: "response";
      id: number;
      ok: true;
      result: unknown;
    })
  | (SubagentMessageEnvelope & {
      kind: "response";
      id: number;
      ok: false;
      error: string;
    })
  | (SubagentMessageEnvelope & { kind: "stop" })
  | (SubagentMessageEnvelope & {
      kind: "message";
      text: string;
      replyTo?: number;
    });

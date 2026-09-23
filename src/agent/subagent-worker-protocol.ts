/*
 * 定义单个 subagent Worker 与任务所在主进程的消息协议，供 Worker 与协调器共同使用。
 *
 * 1. SubagentWorkerInput 只携带角色、任务与限额，不传模型密钥或写入能力。
 * 2. request/response 给模型、只读工具与检查点提供同一递增 ID 关联。
 * 3. message 在 Worker 下次模型轮次前追加主 agent 消息；finish 与 stop 分别是子 loop 终态提议和主任务取消通知，确认退出后才归还租约。
 *
 * 类型只用于静态约束；父进程仍需按受信任任务身份与正向工具白名单检查消息内容。
 */

export interface SubagentWorkerInput {
  id: string;
  role: string;
  objective: string;
  scope: string[];
  deliverable: string;
  maxSteps: number;
}

export type SubagentWorkerRequest = {
  kind: "request";
  id: number;
  operation: "model" | "read" | "checkpoint";
  payload: unknown;
};

export type SubagentWorkerMessage =
  | SubagentWorkerRequest
  | {
      kind: "finish";
      status: "completed" | "failed" | "cancelled";
      report: string;
      context: unknown[];
    };

export type SubagentParentMessage =
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: string }
  | { kind: "stop" }
  | { kind: "message"; text: string };

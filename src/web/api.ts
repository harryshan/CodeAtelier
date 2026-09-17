/**
 * 封装浏览器到本机后端的 JSON 请求，供页面、设置表单、时间线和连接 Hook 共用。
 * 统一补上 /api 前缀，并保存 bootstrap 返回的本机会话令牌。
 *
 * 1. api 组装方法、请求体和令牌，解析响应或抛出错误；收到 401 时刷新凭据并最多重试一次。
 * 2. bootstrap 获取公开配置，同时更新模块内的令牌。
 * 3. sessions、snapshot 和 sessionTraceTaskIds 提供带类型的会话列表、快照及已保存 trace 清单读取函数。
 *
 * 401 表示请求在鉴权时已被拒绝，因此可以重试。网络错误无法确定写操作是否执行，不能自动重发。
 * 这里保存的是本机会话令牌，不是模型 API 密钥。
 */

import type { Settings, Session, Snapshot } from "../shared/types";

let token = "";

export async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  refreshed = false,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CodeAtelier-Token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  // 401 说明请求已被鉴权拒绝，可以刷新凭据后重试；网络错误则无法确定操作是否执行。
  if (
    response.status === 401 &&
    !["/bootstrap", "/access/login"].includes(url) &&
    !refreshed
  ) {
    await bootstrap();

    return api<T>(url, body, method, true, signal);
  }

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "请求失败");
  }

  return result;
}

export async function bootstrap() {
  const value = await api<{
    token: string;
    settings: Settings;
    hasApiKey: boolean;
  }>("/bootstrap");

  token = value.token;

  return value;
}

export const sessions = () => api<Session[]>("/sessions");

export const snapshot = (id: string, signal?: AbortSignal) =>
  api<Snapshot>("/sessions/" + id, undefined, "GET", false, signal);

export const sessionTraceTaskIds = (id: string) =>
  api<{ taskIds: string[] }>("/sessions/" + id + "/traces");

export type AccessStatus = {
  enabled: boolean;
  authenticated: boolean;
};

/** 在加载主界面前读取服务端访问门禁状态；该端点不要求已有本机会话。 */
export const accessStatus = () => api<AccessStatus>("/access/status");

/** 仅把用户在当前表单输入的密码交给同源后端，成功后的状态由 HttpOnly cookie 保存。 */
export const loginAccess = (password: string) =>
  api<{ ok: true }>("/access/login", { password });

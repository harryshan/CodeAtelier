/**
 * 封装浏览器到本机后端的 JSON 请求，供页面、设置表单、时间线和连接 Hook 共用。
 * 统一补上 /api 前缀，并保存 bootstrap 返回的本机会话令牌。
 *
 * 1. api 组装方法、请求体和令牌，解析响应或抛出错误；收到 401 时刷新凭据并最多重试一次。
 * 2. bootstrap 获取公开配置，同时更新模块内的令牌。
 * 3. sessions 和 snapshot 提供带类型的会话列表、快照读取函数。
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
): Promise<T> {
  const response = await fetch("/api" + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CodeAtelier-Token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 401 说明请求已被鉴权拒绝，可以刷新凭据后重试；网络错误则无法确定操作是否执行。
  if (response.status === 401 && url !== "/bootstrap" && !refreshed) {
    await bootstrap();

    return api<T>(url, body, method, true);
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

export const snapshot = (id: string) => api<Snapshot>("/sessions/" + id);

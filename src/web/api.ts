/**
 * 文件作用：封装浏览器对本机后端的 JSON 请求和会话凭据初始化。
 * 代码结构：api 统一请求头、序列化及错误处理，bootstrap 更新凭据，末尾提供会话列表和快照读取函数。
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

  // 401 表示服务端尚未执行此操作；网络结果未知时不能自动重放写请求。
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

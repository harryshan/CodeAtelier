/**
 * 文件作用：封装浏览器对本机后端的 JSON 请求和会话凭据初始化。
 *
 * 模块协作与输入输出：
 * 为 App、SettingsPanel、Timeline 和连接 Hook 提供浏览器 HTTP 调用，统一 /api 路由前缀和凭据处理。
 *
 * 代码结构与执行顺序：
 * 1. api 设置方法、JSON body 与 token；收到明确未执行的 401 后重新 bootstrap 并最多重试一次，再解析响应或抛出错误。
 * 2. bootstrap 获取后端公开配置，同时更新模块内 token。
 * 3. sessions 和 snapshot 封装常用只读端点，返回共享类型数据。
 *
 * 关键约束：
 * 网络错误导致写请求结果未知时不能自动重放；401 才允许一次凭据刷新重试。模块不存储模型 API 密钥。
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

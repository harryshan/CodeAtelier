/**
 * 在渲染 CodeAtelier 主页面或服务托管的对话阅读器前显示可选访问密码门禁。
 * 浏览器入口 main.tsx 用该组件包裹选定页面；它只通过 api.ts 读取服务端状态和提交当前输入，验证结果由服务端 HttpOnly cookie 保存。
 *
 * 1. useEffect 在首次渲染及重试时读取 accessStatus，未启用或已有有效 cookie 时直接渲染 children。
 * 2. submitPassword 提交受控密码输入；成功后仅切换本地门禁状态，主页面与数据库阅读器分别通过 api.ts 建立凭据并读取允许的内容。
 * 3. 加载、服务错误和错误密码分别呈现不可进入主页面的状态与可重试表单。
 *
 * 密码不会保存在 React state 以外的位置、不会写入 localStorage，也不会传给子页面。网络失败不能被当作验证成功。
 */

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { accessStatus, loginAccess, type AccessStatus } from "./api";
import s from "./access-gate.module.css";

type AccessGateProps = {
  children: ReactNode;
};

export function AccessGate({ children }: AccessGateProps) {
  const [status, setStatus] = useState<AccessStatus>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [attempting, setAttempting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let disposed = false;

    setStatus(undefined);
    setError("");
    void accessStatus()
      .then((value) => {
        if (!disposed) {
          setStatus(value);
        }
      })
      .catch((reason: Error) => {
        if (!disposed) {
          setError(reason.message);
        }
      });

    return () => {
      disposed = true;
    };
  }, [reload]);

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempting(true);
    setError("");

    try {
      await loginAccess(password);
      setPassword("");
      setStatus({ enabled: true, authenticated: true });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setAttempting(false);
    }
  };

  if (status && (!status.enabled || status.authenticated)) {
    return children;
  }

  const checking = !status && !error;

  return (
    <main className={s.gate}>
      <section className={s.card} aria-labelledby="access-gate-title">
        <p className={s.eyebrow}>CODEATELIER</p>
        <h1 id="access-gate-title">访问验证</h1>
        {checking ? (
          <p role="status">正在确认访问状态…</p>
        ) : error && !status ? (
          <>
            <p role="alert" className={s.error}>
              无法确认访问状态：{error}
            </p>
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              重试
            </button>
          </>
        ) : (
          <form onSubmit={submitPassword} className={s.form}>
            <p>请输入访问密码后继续使用本机服务。</p>
            <label htmlFor="access-password">访问密码</label>
            <input
              id="access-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              disabled={attempting}
            />
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
            <button type="submit" disabled={attempting}>
              {attempting ? "正在验证…" : "进入 CodeAtelier"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

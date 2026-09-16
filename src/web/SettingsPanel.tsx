/**
 * App 打开的设置表单，用于修改模型连接、思考等级和执行限制。
 * 接收当前配置及保存、关闭回调，通过后端 API 保存修改。
 *
 * 1. 复制当前偏好作为表单初值，另存用户新输入的临时密钥；后端不会返回原密钥，任务并发上限在没有活动或排队任务时可调整。
 * 2. 连接地址和模型只读展示，用户修改 .env 并重启或重载服务后才会更新。
 * 3. 提交时组装 settings 和可选的 apiKey，等待保存并显示错误；表单其余部分为思考等级和执行参数。
 *
 * “已有密钥”只表示后端已配置。配置是否合法、任务运行中能否修改，最终由后端检查。
 */

import { useState } from "react";
import type { Settings } from "../shared/types";
import { api } from "./api";
import s from "./app.module.css";

export function SettingsPanel({
  settings,
  hasKey,
  onSaved,
  onClose,
}: {
  settings: Settings;
  hasKey: boolean;
  onSaved: (v: { settings: Settings; hasApiKey: boolean }) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(settings);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className={s.overlay}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="模型与运行设置"
        className={s.modal}
      >
        <div className={s.modalHeading}>
          <div>
            <small>WORKSPACE PREFERENCES</small>
            <h2>模型与运行设置</h2>
          </div>
          <button onClick={onClose} aria-label="关闭设置">
            ✕
          </button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await api<{
                settings: Settings;
                hasApiKey: boolean;
              }>(
                "/settings",
                { settings: value, ...(key ? { apiKey: key } : {}) },
                "PUT",
              );

              setKey("");
              onSaved(result);
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <section aria-label="连接配置">
            <h3>连接配置</h3>
            <p className={s.muted}>
              API 地址和模型只从本地 <code>.env</code>
              （或进程环境）读取；为避免来源冲突，不能在此保存。
              修改后请重启或重载服务。
            </p>
            <p>
              API Base URL：<code>{settings.baseUrl}</code>
            </p>
            <p>
              主模型：<code>{settings.model}</code>
            </p>
            <p>
              辅助模型：
              <code>{settings.auxiliaryModel || "未配置"}</code>
            </p>
          </section>
          <label>
            思考等级
            <select
              value={value.reasoningEffort ?? "high"}
              onChange={(e) =>
                setValue({
                  ...value,
                  reasoningEffort: e.target
                    .value as Settings["reasoningEffort"],
                })
              }
            >
              <option value="low">低（low）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high，默认）</option>
            </select>
          </label>
          <label>
            辅助模型推理强度
            <select
              value={value.auxiliaryReasoningEffort ?? "low"}
              onChange={(e) =>
                setValue({
                  ...value,
                  auxiliaryReasoningEffort: e.target
                    .value as Settings["auxiliaryReasoningEffort"],
                })
              }
            >
              <option value="low">低（low，默认）</option>
              <option value="medium">中（medium）</option>
              <option value="high">高（high）</option>
            </select>
          </label>
          <p className={s.muted}>
            辅助模型共用 API
            地址和密钥，用于上下文摘要、会话标题和工具审批分流。未在 .env
            配置时，标题和摘要沿用主模型；为避免审批使用主模型，审批将保留人工确认。
          </p>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              placeholder={hasKey ? "已配置 · 留空保留" : "输入服务密钥"}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className={s.muted}>
            密钥仅保留在后端内存。本次输入会覆盖当前进程的环境密钥，重启后恢复
            .env 或进程环境中的密钥；留空不修改。
          </p>
          <div className={s.fieldGrid}>
            <label>
              最大模型调用次数
              <input
                type="number"
                min="1"
                max="100"
                value={value.maxSteps}
                onChange={(e) =>
                  setValue({ ...value, maxSteps: Number(e.target.value) })
                }
              />
            </label>
            <label>
              同时运行任务数
              <input
                type="number"
                min="1"
                max="4"
                value={value.maxConcurrentTasks}
                onChange={(e) =>
                  setValue({
                    ...value,
                    maxConcurrentTasks: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              命令超时（秒）
              <input
                type="number"
                min="1"
                max="600"
                value={value.commandTimeoutMs / 1000}
                onChange={(e) =>
                  setValue({
                    ...value,
                    commandTimeoutMs: Number(e.target.value) * 1000,
                  })
                }
              />
            </label>
            {(
              [
                ["requestTimeoutMs", "模型请求超时（秒）"],
                ["idleTimeoutMs", "模型空闲超时（秒）"],
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  type="number"
                  min="1"
                  max={field === "idleTimeoutMs" ? 300 : 600}
                  value={value[field] / 1000}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [field]: Number(e.target.value) * 1000,
                    })
                  }
                />
              </label>
            ))}
            <label>
              备用上下文字符上限
              <input
                type="number"
                min="10000"
                max="2000000"
                value={value.contextChars}
                onChange={(e) =>
                  setValue({ ...value, contextChars: Number(e.target.value) })
                }
              />
            </label>
            <label>
              最大输出 token
              <input
                type="number"
                min="1"
                max="2000000"
                value={value.maxOutputTokens ?? 16384}
                onChange={(e) =>
                  setValue({
                    ...value,
                    maxOutputTokens: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              日志级别
              <select
                value={value.logLevel}
                onChange={(e) =>
                  setValue({ ...value, logLevel: e.target.value })
                }
              >
                {["trace", "debug", "info", "warn", "error"].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <button className={s.primary} disabled={busy}>
            {busy ? "保存中…" : "保存设置"}
          </button>
        </form>
      </section>
    </div>
  );
}

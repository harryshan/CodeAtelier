/**
 * 文件作用：提供模型连接、思考等级和执行参数的设置表单。
 * 代码结构：SettingsPanel 初始化表单状态，处理保存和错误反馈，再渲染参数输入与操作按钮。
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
          <label>
            API Base URL
            <input
              value={value.baseUrl}
              onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
            />
          </label>
          <label>
            模型
            <input
              value={value.model}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
            />
          </label>
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
            密钥仅保留在后端内存。重启后可重新输入，或通过环境变量配置。
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

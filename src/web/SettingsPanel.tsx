/**
 * App 打开的设置表单，用于修改模型连接、思考等级和执行限制。
 * 接收当前配置及保存、关闭回调，通过后端 API 保存修改。
 *
 * 1. 复制当前设置作为表单初值，另存用户新输入的密钥；后端不会返回原密钥。
 * 2. 提交时组装 settings 和可选的 apiKey，等待保存并显示错误。
 * 3. 表单依次显示连接、主辅模型和执行参数，末尾提供保存与取消按钮；低成本辅助模型也用于审批分流。
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
            辅助模型（低成本，可选）
            <input
              value={value.auxiliaryModel ?? ""}
              placeholder="留空：审批保留人工确认"
              onChange={(e) =>
                setValue({ ...value, auxiliaryModel: e.target.value })
              }
            />
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
            地址和密钥，用于上下文摘要、会话标题和工具审批分流。留空时标题和摘要沿用主模型；为避免审批使用主模型，审批将保留人工确认。
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

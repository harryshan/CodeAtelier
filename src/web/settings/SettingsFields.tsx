/**
 * 设置页的具名字段组件，接收公开草稿和变更回调，不自行请求后端或持久化。
 * 1. SecretField 显式区分保留、替换与删除；原凭据从不进入控件。
 * 2. ModelFields 编辑主/辅助连接及继承关系，按协议标明能力并禁用不适用思考项。
 * 3. NumericFields 用统一标签、单位和范围渲染执行/上下文/诊断参数。
 * 所有新凭据仅留在父组件内存，关闭页面或成功保存后清空。
 */
import { useId, useState } from "react";
import type { PublicSettingsDocument } from "../../config/settings-document";
import { protocolFeatures } from "../../providers/protocol";

type Model = PublicSettingsDocument["models"]["main"];
type Auxiliary = PublicSettingsDocument["models"]["auxiliary"];

export function SecretField({
  label,
  configured,
  value,
  onChange,
  allowDelete = true,
}: {
  label: string;
  configured: boolean;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allowDelete?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState("keep");

  return (
    <div>
      <label htmlFor={id}>
        {label} · {configured ? "已配置" : "未配置"}
      </label>
      <select
        id={id}
        value={value === undefined ? "keep" : mode}
        onChange={(event) => {
          setMode(event.target.value);
          onChange(event.target.value === "keep" ? undefined : "");
        }}
      >
        <option value="keep">保留原值</option>
        <option value="replace">替换</option>
        {allowDelete && <option value="delete">删除密钥</option>}
      </select>
      {value !== undefined && mode === "replace" && (
        <input
          aria-label={`${label}新值`}
          type="password"
          autoComplete="new-password"
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function ModelFields({
  value,
  onChange,
  label,
  keyValue,
  onKeyChange,
  mainProtocol,
}: {
  value: Model | Auxiliary;
  onChange: (patch: Partial<Auxiliary>) => void;
  label: string;
  keyValue: string | undefined;
  onKeyChange: (value: string | undefined) => void;
  mainProtocol: Model["protocol"];
}) {
  const auxiliary = "enabled" in value;
  const inherits = auxiliary && value.inheritConnection;
  const enabled = !auxiliary || value.enabled;
  const protocol = inherits ? mainProtocol : value.protocol;

  return (
    <section>
      <h3>
        {label} <small>下一任务生效</small>
      </h3>
      {auxiliary && (
        <>
          <label>
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            启用辅助模型
          </label>
          <p>未启用时，标题和摘要使用主模型，审批交由人工。</p>
          <label>
            <input
              type="checkbox"
              checked={value.inheritConnection}
              onChange={(e) =>
                onChange({ inheritConnection: e.target.checked })
              }
            />
            继承主模型协议与地址
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.inheritKey}
              onChange={(e) => onChange({ inheritKey: e.target.checked })}
            />
            继承主密钥（仅限同连接）
          </label>
        </>
      )}
      <label>
        {label}协议
        <select
          aria-label={`${label}协议`}
          value={value.protocol}
          disabled={!enabled || inherits}
          onChange={(e) =>
            onChange({ protocol: e.target.value as Model["protocol"] })
          }
        >
          <option value="responses">Responses</option>
          <option value="chat-completions">Chat Completions</option>
          <option value="messages">Anthropic Messages</option>
        </select>
      </label>
      <label>
        {label} API 地址
        <input
          type="url"
          value={value.baseUrl}
          disabled={!enabled || inherits}
          placeholder="https://api.example.test/v1"
          onChange={(e) => onChange({ baseUrl: e.target.value })}
        />
      </label>
      <label>
        {label}名称
        <input
          value={value.model}
          disabled={!enabled}
          maxLength={200}
          placeholder="完整模型标识"
          onChange={(e) => onChange({ model: e.target.value })}
        />
      </label>
      <label>
        {label}思考等级
        <select
          aria-label={`${label}思考等级`}
          value={value.reasoningEffort}
          disabled={!enabled || !protocolFeatures(protocol).reasoningEffort}
          onChange={(e) =>
            onChange({
              reasoningEffort: e.target.value as Model["reasoningEffort"],
            })
          }
        >
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
      </label>
      <p>
        {protocol === "responses"
          ? "Responses 支持思考参数及内置搜索。"
          : "当前协议仅支持文字与本地工具，不发送思考参数或内置搜索。"}
      </p>
      <SecretField
        label={`${label}密钥`}
        configured={value.hasKey}
        value={keyValue}
        onChange={onKeyChange}
      />
      <p>
        改变地址或协议时，请重新输入或明确删除原密钥；保存不会产生模型请求。
      </p>
    </section>
  );
}

export const numericFields = {
  maxSteps: ["任务最大轮次", 1, 100],
  maxConcurrentTasks: ["并行任务上限（立即生效）", 1, 4],
  requestTimeoutMs: ["模型请求时限（毫秒）", 1000, 600000],
  idleTimeoutMs: ["模型空闲时限（毫秒）", 1000, 300000],
  outputChars: ["工具输出字符上限", 1000, 100000],
  maxOutputTokens: ["模型输出 token 预留", 1, 2000000],
  maxContextTokens: ["上下文 token 上限", 4096, 2000000],
  contextChars: ["备用上下文字符上限", 10000, 2000000],
  port: ["服务端口（重启生效）", 1, 65535],
  maxRecords: ["每任务 trace 记录数", 100, 1000000],
  maxBytes: ["每任务 trace 字节上限", 65536, 268435456],
  checkpointMs: ["检查点间隔（毫秒，重启生效）", 5000, 3600000],
  retentionDays: ["归档保留天数（0 不删除，重启生效）", 0, 3650],
} as const;

export function NumericFields({
  value,
  onChange,
}: {
  value: Partial<Record<keyof typeof numericFields, number>>;
  onChange: (patch: Record<string, number>) => void;
}) {
  return (
    <>
      {Object.entries(value).map(([name, current]) => {
        const field = numericFields[name as keyof typeof numericFields];

        return (
          <label key={name}>
            {field[0]}
            <input
              type="number"
              min={field[1]}
              max={field[2]}
              step={1}
              required
              value={current}
              onChange={(event) =>
                onChange({ [name]: Number(event.target.value) })
              }
            />
          </label>
        );
      })}
    </>
  );
}

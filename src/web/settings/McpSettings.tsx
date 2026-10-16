/**
 * MCP 设置分类的写入式编辑器，父设置页持有待提交变更，切换分类不丢草稿。
 * 1. 仅展示服务 ID/transport/开关，不回显可能包含秘密的命令、参数、URL、env 或 headers。
 * 2. 新增/替换用明确字段组成完整服务配置，删除按 ID 标记；统一保存前不连接服务。
 * 3. JSON 字段仅解析为数据，错误保留输入，不执行命令或脚本。
 */
import { useState } from "react";
import type { PublicSettingsDocument } from "../../config/settings-document";

export function McpSettings({
  servers,
  changes,
  onChange,
}: {
  servers: PublicSettingsDocument["mcp"]["servers"];
  changes: Record<string, unknown>;
  onChange: (changes: Record<string, unknown>) => void;
}) {
  const [id, setId] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [enabled, setEnabled] = useState(true);
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("[]");
  const [credentials, setCredentials] = useState("{}");
  const [cwd, setCwd] = useState("");
  const [timeout, setTimeoutValue] = useState(60000);
  const [error, setError] = useState("");

  return (
    <>
      <h2>
        MCP 服务 <small>下一任务生效</small>
      </h2>
      <p>
        保存只更新配置，不连接服务、不执行命令。已有连接参数可能含密钥，因此不回显；修改时完整替换该服务。
      </p>
      <ul>
        {servers.map((server) => (
          <li key={server.id}>
            <strong>{server.id}</strong> · {server.transport} ·{" "}
            {server.enabled ? "启用" : "停用"}
            <button
              type="button"
              onClick={() => {
                setId(server.id);
                setTransport(server.transport);
                setTarget("");
                setArgs("[]");
                setCredentials("{}");
              }}
            >
              替换 {server.id}
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...changes, [server.id]: null })}
            >
              删除 {server.id}
            </button>
          </li>
        ))}
      </ul>
      {Object.keys(changes).length > 0 && (
        <p>
          待保存服务：{Object.keys(changes).join("、")}{" "}
          <button type="button" onClick={() => onChange({})}>
            撤销 MCP 修改
          </button>
        </p>
      )}
      <fieldset>
        <legend>新增或完整替换服务</legend>
        <label>
          服务 ID
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            pattern="[A-Za-z][A-Za-z0-9_-]{0,63}"
          />
        </label>
        <label>
          用途说明
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          传输方式
          <select
            value={transport}
            onChange={(e) => {
              setTransport(e.target.value);
              setTarget("");
              setCredentials("{}");
            }}
          >
            <option value="stdio">本机 stdio</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用服务
        </label>
        <label>
          {transport === "stdio" ? "命令路径" : "服务 URL"}
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoComplete="off"
          />
        </label>
        {transport === "stdio" && (
          <>
            <label>
              参数（JSON 字符串数组）
              <textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
            <label>
              工作目录（绝对路径，可留空）
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </label>
          </>
        )}
        <label>
          {transport === "stdio" ? "环境变量" : "请求头"}（JSON
          对象，可能含凭据）
          <textarea
            value={credentials}
            onChange={(e) => setCredentials(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          连接时限（毫秒）
          <input
            type="number"
            value={timeout}
            min={100}
            max={300000}
            onChange={(e) => setTimeoutValue(Number(e.target.value))}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          onClick={() => {
            try {
              if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !target) {
                throw new Error();
              }

              const entry = {
                transport,
                enabled,
                timeoutMs: timeout,
                ...(description ? { description } : {}),
                ...(transport === "stdio"
                  ? {
                      command: target,
                      args: JSON.parse(args),
                      env: JSON.parse(credentials),
                      ...(cwd ? { cwd } : {}),
                    }
                  : { url: target, headers: JSON.parse(credentials) }),
              };
              onChange({ ...changes, [id]: entry });
              setError("");
              setTarget("");
              setCredentials("{}");
              setArgs("[]");
            } catch {
              setError("请检查服务 ID、连接目标和 JSON 格式。");
            }
          }}
        >
          加入待保存更改
        </button>
      </fieldset>
    </>
  );
}

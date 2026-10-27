/**
 * 主页面上的设置模态框，由 App 打开；类别切换保留草稿，保存使用 revision 局部差异而非旧全量对象。
 * 1. changesBetween/applyChanges 只处理公开值，支持多标签冲突后保留用户改动并显示受影响分类。
 * 2. SettingsPage 加载、安全退出、保存/校验、显式重读、脱敏导出和受监督重启各自独立。
 * 3. 分类内容交给 ModelFields/McpSettings，密钥草稿只在内存，成功保存或退出即清除。
 * 4. 原生 dialog 隔离背景，退出恢复焦点/滚动；导航、独立表单滚动和固定保存栏适配窄屏，Esc 沿用草稿确认。
 */
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../../shared/types";
import type { PublicSettingsDocument } from "../../config/settings-document";
import type { SettingsEditorView } from "../../config/settings-store";
import { api } from "../api";
import { ModelFields, NumericFields, SecretField } from "./SettingsFields";
import { McpSettings } from "./McpSettings";
import s from "./settings.module.css";

type Response = {
  settings: Settings;
  hasApiKey: boolean;
  editor: SettingsEditorView;
};
type JsonObject = Record<string, unknown>;
const categories = [
  ["models", "模型连接", "协议 地址 名称 密钥 思考 辅助"],
  ["execution", "任务与上下文", "轮次 时限 输出 token 字符"],
  ["sandbox", "Sandbox 与权限", "隔离 授权 安装 路径"],
  ["mcp", "MCP 服务", "命令 传输 凭据 用途"],
  ["server", "服务与访问", "监听 端口 密码 局域网"],
  ["logging", "日志与诊断", "日志 trace 保留 容量 检查点"],
  ["data", "配置与数据", "路径 版本 迁移 重启 导出"],
] as const;

function changesBetween(before: JsonObject, after: JsonObject): JsonObject {
  const changes: JsonObject = {};
  for (const [key, value] of Object.entries(after)) {
    if (["hasKey", "hasPassword", "schemaVersion", "mcp"].includes(key)) {
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = changesBetween(
        before[key] as JsonObject,
        value as JsonObject,
      );
      if (Object.keys(child).length) {
        changes[key] = child;
      }
    } else if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
      changes[key] = value;
    }
  }

  return changes;
}

function applyChanges(target: JsonObject, changes: JsonObject): JsonObject {
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(changes)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? applyChanges(result[key] as JsonObject, value as JsonObject)
        : value;
  }

  return result;
}

export function SettingsPage({
  onSaved,
  onClose,
}: {
  onSaved: (value: { settings: Settings; hasApiKey: boolean }) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<SettingsEditorView>();
  const [draft, setDraft] = useState<PublicSettingsDocument>();
  const [category, setCategory] = useState("models");
  const [search, setSearch] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string | undefined>>(
    {},
  );
  const [mcpChanges, setMcpChanges] = useState<JsonObject>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [epoch, setEpoch] = useState(0);
  const panel = useRef<HTMLDialogElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const changes =
    view && draft
      ? changesBetween(
          view.configuration as unknown as JsonObject,
          draft as unknown as JsonObject,
        )
      : {};
  const dirty =
    Object.keys(changes).length > 0 ||
    Object.values(secrets).some((value) => value !== undefined) ||
    Object.keys(mcpChanges).length > 0;

  useEffect(() => {
    const controller = new AbortController();
    const previous = document.activeElement as HTMLElement | null;
    const dialog = panel.current;
    const previousOverflow = document.body.style.overflow;
    // 原生模态状态隔离背景，避免仅靠遮罩或 Tab 循环仍能操作主页面。
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    void api<Response>("/settings", undefined, "GET", false, controller.signal)
      .then((value) => {
        setView(value.editor);
        setDraft(value.editor.configuration);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      });

    return () => {
      controller.abort();
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (error) {
      alert.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const close = () => {
    if (!busy && (!dirty || window.confirm("放弃尚未保存的设置和凭据草稿？"))) {
      onClose();
    }
  };

  const changeGroup = (
    group: keyof PublicSettingsDocument,
    patch: JsonObject,
  ) => {
    setDraft((current) =>
      current
        ? { ...current, [group]: { ...(current[group] as object), ...patch } }
        : current,
    );
  };

  const request = () => ({
    expectedRevision: view!.revision,
    changes,
    secretChanges: secrets,
    mcpChanges,
  });
  const save = async (validate = false) => {
    if (!view) {
      return;
    }

    const sensitive =
      !!changes.sandbox || !!changes.server || !!changes.tracing;
    if (
      !validate &&
      view.migrationRequired &&
      !window.confirm(
        "将当前有效旧配置和凭据迁入私有 settings.json（非加密文件），并保留旧文件备份？不会删除 .env 或重启。",
      )
    ) {
      return;
    }

    if (
      sensitive &&
      !window.confirm(
        "保存可能改变访问范围、隔离权限或归档保留策略。运行中任务不变，相关项重启后生效；确认保存此配置？",
      )
    ) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const payload = {
        ...request(),
        confirmMigration: view.migrationRequired,
        confirmSensitive: sensitive,
      };
      if (validate) {
        await api("/settings/validate", payload);
        setNotice("校验通过，尚未保存；没有连接任何模型或 MCP 服务。");
      } else {
        const result = await api<Response>("/settings", payload, "PATCH");
        setView(result.editor);
        setDraft(result.editor.configuration);
        setSecrets({});
        setMcpChanges({});
        setEpoch((value) => value + 1);
        onSaved(result);
        setNotice(
          "已保存。日志立即应用；连接与预算在下一任务生效；运行中的任务保持原配置。",
        );
      }
    } catch (reason) {
      setError(
        (reason as Error).message +
          " 草稿已保留；若响应中断，请重新读取确认状态，不要盲目重复保存。",
      );
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (fromDisk = false) => {
    if (!view) {
      return;
    }

    if (
      fromDisk &&
      !window.confirm(
        "采用磁盘上的完整配置？权限和服务变更仍需重启；当前草稿将按字段重新应用，请复核。",
      )
    ) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const result = await api<Response>(
        fromDisk ? "/settings/reload" : "/settings",
        fromDisk
          ? { expectedRevision: view.revision, confirm: true }
          : undefined,
      );
      setView(result.editor);
      setDraft(
        applyChanges(
          result.editor.configuration as unknown as JsonObject,
          changes,
        ) as unknown as PublicSettingsDocument,
      );
      onSaved(result);
      setNotice(
        `已取得最新配置，保留草稿分类：${Object.keys(changes).join("、") || "无"}。请复核再保存。`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      className={s.page}
      aria-modal="true"
      aria-label="CodeAtelier 设置"
      ref={panel}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const nodes = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
            ) ?? []),
          ].filter((node) => node.offsetParent !== null);
          const first = nodes[0];
          const last = nodes.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              !nodes.includes(document.activeElement as HTMLElement))
          ) {
            event.preventDefault();
            last?.focus();
          }

          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header>
        <div>
          <small>CODEATELIER</small>
          <h2>设置</h2>
          <p>{view?.path ?? "正在读取配置…"}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={close}
          aria-label="关闭设置"
        >
          关闭
        </button>
      </header>
      <div className={s.layout}>
        <nav aria-label="设置分类">
          <label>
            查找设置
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {categories
            .filter((entry) =>
              entry.join(" ").toLowerCase().includes(search.toLowerCase()),
            )
            .map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-current={category === id ? "page" : undefined}
                onClick={() => setCategory(id)}
              >
                {label}
              </button>
            ))}
        </nav>
        <form
          className={s.content}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className={s.scrollArea}>
            {error && (
              <p role="alert" tabIndex={-1} ref={alert} className={s.error}>
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className={s.notice}>
                {notice}
              </p>
            )}
            {view?.migrationRequired && (
              <p className={s.notice}>
                当前使用旧配置。首次保存会要求确认迁移；原 .env 不会被删除。私有
                JSON 包含明文模型/MCP 凭据，不是加密保险库。
              </p>
            )}
            {!!view?.pendingRestart.length && (
              <p className={s.notice}>
                已保存，待重启：{view.pendingRestart.join("、")}
                。不会自动取消任务或重启。
              </p>
            )}
            {draft && (
              <fieldset disabled={busy} className={s.fields}>
                <div hidden={category !== "models"}>
                  <h2>模型连接</h2>
                  {(["main", "auxiliary"] as const).map((which) => (
                    <ModelFields
                      key={`${which}-${epoch}`}
                      value={draft.models[which]}
                      label={which === "main" ? "主模型" : "辅助模型"}
                      mainProtocol={draft.models.main.protocol}
                      keyValue={
                        secrets[which === "main" ? "mainKey" : "auxiliaryKey"]
                      }
                      onKeyChange={(value) =>
                        setSecrets({
                          ...secrets,
                          [which === "main" ? "mainKey" : "auxiliaryKey"]:
                            value,
                        })
                      }
                      onChange={(patch) =>
                        changeGroup("models", {
                          [which]: { ...draft.models[which], ...patch },
                        })
                      }
                    />
                  ))}
                </div>
                <div hidden={category !== "execution"}>
                  <h2>任务与上下文</h2>
                  <p>
                    任务在实际开始时采用最新配置。不同会话可在同目录并行，主任务数量无上限；请注意文件/Git
                    冲突、测试干扰和资源耗尽风险。同一会话仍只允许一个活动任务。工具执行没有固定总时限。
                  </p>
                  <NumericFields
                    value={draft.execution}
                    onChange={(patch) => changeGroup("execution", patch)}
                  />
                  <h3>上下文预算 · 下一任务生效</h3>
                  <NumericFields
                    value={draft.context}
                    onChange={(patch) => changeGroup("context", patch)}
                  />
                </div>
                <div hidden={category !== "sandbox"}>
                  <h2>Sandbox 与权限 · 重启生效</h2>
                  <p>
                    这里是请求配置，不代表已安装或已隔离。保存不会安装组件或提升权限；实际执行状态仍见对话页面。macOS
                    尚未实机验证。
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.sandbox.enabled}
                      onChange={(e) =>
                        changeGroup("sandbox", { enabled: e.target.checked })
                      }
                    />
                    请求启用 Sandbox
                  </label>
                  {(["readRoots", "writeRoots"] as const).map((key) => (
                    <label key={key}>
                      {key === "readRoots"
                        ? "POSIX 额外只读根"
                        : "POSIX 额外可写根"}
                      （每行一个绝对路径）
                      <textarea
                        value={draft.sandbox[key].join("\n")}
                        onChange={(e) =>
                          changeGroup("sandbox", {
                            [key]: e.target.value.split("\n"),
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    Windows 原生安装根（空为默认）
                    <input
                      value={draft.sandbox.nativeRoot}
                      onChange={(e) =>
                        changeGroup("sandbox", { nativeRoot: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Windows 安装状态路径（空为默认）
                    <input
                      value={draft.sandbox.statePath}
                      onChange={(e) =>
                        changeGroup("sandbox", { statePath: e.target.value })
                      }
                    />
                  </label>
                </div>
                <div hidden={category !== "mcp"}>
                  <McpSettings
                    key={epoch}
                    servers={draft.mcp.servers}
                    changes={mcpChanges}
                    onChange={setMcpChanges}
                  />
                </div>
                <div hidden={category !== "server"}>
                  <h2>服务与访问 · 重启生效</h2>
                  <p>
                    仅供本机和受信任局域网使用。密码不提供 HTTP
                    传输加密；重启会中断活动任务并要求重新登录。
                  </p>
                  <label>
                    监听地址
                    <select
                      value={draft.server.listenAddress}
                      onChange={(e) =>
                        changeGroup("server", { listenAddress: e.target.value })
                      }
                    >
                      {["127.0.0.1", "::1", "0.0.0.0", "::"].map((address) => (
                        <option key={address}>{address}</option>
                      ))}
                    </select>
                  </label>
                  <NumericFields
                    value={{ port: draft.server.port }}
                    onChange={(patch) => changeGroup("server", patch)}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.server.passwordEnabled}
                      onChange={(e) =>
                        changeGroup("server", {
                          passwordEnabled: e.target.checked,
                        })
                      }
                    />
                    启用访问密码
                  </label>
                  <SecretField
                    key={epoch}
                    label="访问密码"
                    configured={draft.server.hasPassword}
                    value={secrets.password}
                    onChange={(value) =>
                      setSecrets({ ...secrets, password: value })
                    }
                    allowDelete={false}
                  />
                </div>
                <div hidden={category !== "logging"}>
                  <h2>日志与诊断</h2>
                  <label>
                    宿主日志级别 · 立即生效
                    <select
                      value={draft.logging.level}
                      onChange={(e) =>
                        changeGroup("logging", { level: e.target.value })
                      }
                    >
                      {["trace", "debug", "info", "warn", "error"].map(
                        (level) => (
                          <option key={level}>{level}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <p>
                    现有 Runtime 保留启动时级别。trace
                    容量下一任务生效；检查点和归档保留策略重启生效。
                  </p>
                  <NumericFields
                    value={draft.tracing}
                    onChange={(patch) => changeGroup("tracing", patch)}
                  />
                </div>
                <div hidden={category !== "data"}>
                  <h2>配置与数据</h2>
                  <p>
                    配置版本：{draft.schemaVersion}；revision：{view?.revision}
                  </p>
                  <p>
                    数据目录通过启动参数 --data-dir
                    指定，不在运行中搬迁历史数据库。Skill
                    仍从项目/宿主预设目录发现。
                  </p>
                  <button type="button" onClick={() => void refresh(true)}>
                    重新读取磁盘配置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob(
                          [JSON.stringify(view?.configuration, null, 2)],
                          {
                            type: "application/json",
                          },
                        ),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "codeatelier-settings-redacted.json";
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    导出脱敏配置（非备份）
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `重启将中断运行任务；新端口为 ${view?.configuration.server.port}。未保存的草稿不会生效。确认？`,
                        )
                      ) {
                        return;
                      }

                      try {
                        await api("/server/reload", { confirm: true });
                        setNotice(
                          "已请求重启；请使用保存的地址和端口重新打开服务。",
                        );
                      } catch (reason) {
                        setError((reason as Error).message);
                      }
                    }}
                  >
                    重启服务
                  </button>
                </div>
              </fieldset>
            )}
          </div>
          <footer>
            <span>{dirty ? "有未保存更改" : "无未保存更改"}</span>
            <button
              type="button"
              disabled={busy || !view}
              onClick={() => void refresh()}
            >
              重新读取并保留草稿
            </button>
            <button
              type="button"
              disabled={busy || !view}
              onClick={() => void save(true)}
            >
              校验
            </button>
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => {
                if (window.confirm("放弃所有草稿？")) {
                  setDraft(view?.configuration);
                  setSecrets({});
                  setMcpChanges({});
                  setEpoch((value) => value + 1);
                }
              }}
            >
              放弃修改
            </button>
            <button type="submit" disabled={busy || !view}>
              {busy ? "处理中…" : "保存更改"}
            </button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}

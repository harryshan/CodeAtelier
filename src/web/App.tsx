/**
 * CodeAtelier 的主页面，负责选择会话、提交任务和打开设置等用户操作。
 * 通过 api 请求后端，通过 useSessionConnection 同步会话，再交给 Timeline 和分类 SettingsPage 展示。
 *
 * 0. workspaceDescription 按后端解释实时 lower、固定 CoW 或 Git 提交基线，供实际路径提示使用。
 * 1. 状态和 effects 管理当前会话、默认关闭的一次性 subagent 勾选、服务端能力标志、弹窗及加载状态；useHistoryScroll 自动加载旧页，Timeline 保持阅读位置；历史加载使用低强调状态行，读取失败独立警告并允许重试。
 * 2. 按服务端来源项目路径分组（旧 Local 使用实际路径）；项目可折叠并默认显示最近五个对话。新建默认 Riftri、失败重试保留请求 UUID；WorktreeDialog 显式创建提交基线目录。项目栏显示模式及实际路径，手机端使用导航抽屉。
 * 3. resume、reloadService、stopServer、createProject、createConversation 和 send 处理恢复、受确认的服务重载、关闭服务、连接项目、新建会话和发送消息，并显示操作结果。
 * 4. 服务关闭后显示重启说明；正常页面由侧栏或手机端导航抽屉、项目栏、当前会话实际 Runtime 隔离模式（没有证据时显示启动初始状态，并提示获批宿主命令例外）、可折叠会话统计、会将已完成任务过程默认收纳的时间线或项目连接页、所见即所得 Markdown 任务编辑器组成。
 * 5. 侧栏另开同源对话阅读器；SettingsPage 接管版本化编辑和初始引导，保存更新主页面状态，不中断活动任务。
 * 6. 末尾渲染与主页面同主题的设置模态框及重载/关闭确认框；未完成模型配置时阻止提交并引导设置，项目连接不使用弹窗。
 *
 * 关闭请求失败时不能断言服务已经关闭。切换会话和断线重连都只更新显示，不能重新提交任务。
 */

import { useSessionConnection } from "./useSessionConnection";
import { useHistoryScroll } from "./useHistoryScroll";
import { useEffect, useRef, useState } from "react";
import type { SandboxStatus, Session, Settings } from "../shared/types";
import { api, bootstrap, sessions } from "./api";
import { MarkdownTaskEditor } from "./MarkdownTaskEditor";
import { SettingsPage } from "./settings/SettingsPage";
import { Timeline } from "./Timeline";
import { SessionStatistics } from "./SessionStatistics";
import { WorktreeDialog, requestId } from "./WorktreeDialog";
import s from "./app.module.css";

const RECENT_CONVERSATION_LIMIT = 5;

function workspaceDescription(worktree: Session["worktree"]) {
  if (!worktree) {
    return undefined;
  }

  let baseline: string;
  if (worktree.backend === "riftri-winfsp") {
    baseline = "实时读取主目录，工作文件写入私有层；Git objects/refs 共享";
  } else if (worktree.mode === "riftri") {
    baseline = "主目录创建时状态（包含脏文件）";
  } else {
    baseline = `${worktree.baseRef ?? "未知"} (${worktree.baseCommit?.slice(0, 12) ?? ""})`;
  }

  return `来源：${worktree.projectWorkspace ?? "清单不可用"}；创建基线：${baseline}；存储：${worktree.backend ?? "git"}`;
}

export default function App() {
  const [list, setList] = useState<Session[]>([]);
  const [selected, setSelected] = useState("");
  const [settings, setSettings] = useState<Settings>();
  const [hasKey, setHasKey] = useState(false);
  const [bootstrapSandbox, setBootstrapSandbox] = useState<SandboxStatus>();
  const [showSettings, setShowSettings] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [worktreeProject, setWorktreeProject] = useState<string>();
  const creationRequest = useRef<{ workspace: string; id: string } | undefined>(
    undefined,
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expandedProjectHistories, setExpandedProjectHistories] = useState<
    Set<string>
  >(() => new Set());
  const [collapsedProjectHistories, setCollapsedProjectHistories] = useState<
    Set<string>
  >(() => new Set());
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [subagentsAvailable, setSubagentsAvailable] = useState(false);
  const [subagentsEnabled, setSubagentsEnabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showShutdown, setShowShutdown] = useState(false);
  const [showReload, setShowReload] = useState(false);
  const [serverState, setServerState] = useState<
    "running" | "reloading" | "stopping" | "stopped"
  >("running");
  const {
    data,
    refreshSession,
    connected,
    loading,
    loadOlder,
    loadingOlder,
    olderError,
  } = useSessionConnection(
    selected,
    serverState === "running",
    setSettings,
    setHasKey,
    setBootstrapSandbox,
    setError,
  );
  const scrollArea = useRef<HTMLDivElement>(null);
  useHistoryScroll(scrollArea, data, loadingOlder, olderError, loadOlder);

  useEffect(() => {
    bootstrap()
      .then((v) => {
        setSettings(v.settings);
        setHasKey(v.hasApiKey);
        setBootstrapSandbox(v.sandbox);
        setSubagentsAvailable(v.subagentsAvailable);

        return sessions();
      })
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);

  // 未发送的勾选只属于当前草稿，切换对话不得把它带给另一任务。
  useEffect(() => {
    setSubagentsEnabled(false);
  }, [selected]);

  // bootstrap 仅表示启动配置，不是任务执行结果。重连时它可能晚于已保存的
  // sandbox_stage 抵达；当前会话有实际证据就必须优先显示，切换期间也不能泄漏旧会话状态。
  const sandbox =
    data?.session.id === selected
      ? (data.latestSandbox ?? bootstrapSandbox)
      : bootstrapSandbox;

  useEffect(() => {
    if (!mobileSidebarOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebarOpen]);

  // SSE 刷新的快照含标题生成后的 Session；同步侧栏副本才能即时显示新标题。
  useEffect(() => {
    if (!data?.session) {
      return;
    }

    setList((current) =>
      current.map((session) =>
        session.id === data.session.id ? data.session : session,
      ),
    );
  }, [data?.session]);

  // 路径已由后端解析为真实目录；不在浏览器按操作系统猜测路径大小写。
  const projects = new Map<string, Session[]>();
  for (const session of list) {
    const projectWorkspace =
      session.worktree?.projectWorkspace ?? session.workspace;
    const conversations = projects.get(projectWorkspace) ?? [];
    conversations.push(session);
    projects.set(projectWorkspace, conversations);
  }

  const toggleProjectHistory = (projectWorkspace: string) => {
    setCollapsedProjectHistories((current) => {
      const next = new Set(current);

      if (next.has(projectWorkspace)) {
        next.delete(projectWorkspace);
      } else {
        next.add(projectWorkspace);
      }

      return next;
    });
  };

  const toggleOlderConversations = (projectWorkspace: string) => {
    setExpandedProjectHistories((current) => {
      const next = new Set(current);

      if (next.has(projectWorkspace)) {
        next.delete(projectWorkspace);
      } else {
        next.add(projectWorkspace);
      }

      return next;
    });
  };

  const openProjectForm = () => {
    setMobileSidebarOpen(false);
    setWorkspace("");
    setError("");
    setAddingProject(true);
  };

  const selectedSession = list.find((session) => session.id === selected);
  const active = data?.tasks.find((t) =>
    ["queued", "running", "waiting"].includes(t.status),
  );
  const recoverable = data?.tasks.at(-1);
  const resume = async () => {
    if (!recoverable) {
      return;
    }

    setBusy(true);
    try {
      await api("/tasks/" + recoverable.id + "/resume", {
        instruction: prompt,
      });
      setPrompt("");
      await refreshSession(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const waitForReplacement = async (previousToken: string) => {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const replacement = await bootstrap();

        if (replacement.token !== previousToken) {
          return;
        }
      } catch {
        // 旧进程释放端口和替代进程开始监听之间会短暂断开，继续等待即可。
      }
    }

    throw new Error("服务未在 15 秒内重新启动，请检查启动终端。");
  };

  const reloadService = async () => {
    setServerState("reloading");
    setError("");
    try {
      const current = await bootstrap();

      await api("/server/reload", { confirm: true });
      await waitForReplacement(current.token);
      window.location.reload();
    } catch (error) {
      setServerState("running");
      setShowReload(false);
      setError((error as Error).message);
    }
  };

  const stopServer = async () => {
    setServerState("stopping");
    setError("");
    try {
      await api("/server/shutdown", { confirm: true });
      setServerState("stopped");
    } catch {
      setServerState("running");
      setShowShutdown(false);
      setError(
        "未能确认关闭结果。服务可能已停止，请检查启动终端；可刷新页面确认连接状态。",
      );
    }
  };

  const createConversation = async (projectWorkspace: string) => {
    setBusy(true);
    setError("");
    try {
      if (creationRequest.current?.workspace !== projectWorkspace) {
        creationRequest.current = {
          workspace: projectWorkspace,
          id: requestId(),
        };
      }

      const session = await api<Session>("/sessions", {
        workspace: projectWorkspace,
        riftri: { id: creationRequest.current.id },
      });

      creationRequest.current = undefined;

      setList((current) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ]);
      setSelected(session.id);
      setAddingProject(false);
      setMobileSidebarOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    await createConversation(workspace);
  };

  const send = async () => {
    if (!prompt.trim() || !selected) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api("/sessions/" + selected + "/tasks", {
        prompt,
        subagentsEnabled: subagentsAvailable && subagentsEnabled,
      });
      setPrompt("");
      setSubagentsEnabled(false);
      setList(await sessions());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (serverState === "stopped") {
    return (
      <main className={s.welcome}>
        <h1>服务已关闭</h1>
        <p>历史对话已保存。未完成任务可在重新启动后恢复。</p>
        <p>
          在项目目录运行 <code>pnpm start</code> 后刷新页面。
        </p>
        <button className={s.primary} onClick={() => window.location.reload()}>
          重新连接
        </button>
      </main>
    );
  }

  return (
    <div className={s.app}>
      <aside
        id="primary-navigation"
        aria-label="项目与对话"
        className={
          mobileSidebarOpen ? `${s.sidebar} ${s.mobileSidebarOpen}` : s.sidebar
        }
      >
        <a className={s.brand} href="/">
          <span className={s.logo}>✳</span>
          <span>
            CodeAtelier<small>YOUR LOCAL CODING STUDIO</small>
          </span>
        </a>
        <button className={s.addProjectButton} onClick={openProjectForm}>
          添加项目
        </button>
        <div className={s.sectionLabel}>
          工作记录 <span>{list.length}</span>
        </div>
        <nav className={s.sessionList}>
          {[...projects].map(([projectWorkspace, conversations]) => {
            const projectName =
              projectWorkspace.split(/[\\/]/).filter(Boolean).pop() ||
              projectWorkspace;
            const projectCollapsed =
              collapsedProjectHistories.has(projectWorkspace);
            const showOlderConversations =
              expandedProjectHistories.has(projectWorkspace);
            const visibleConversations = showOlderConversations
              ? conversations
              : conversations.slice(0, RECENT_CONVERSATION_LIMIT);
            const hiddenConversationCount =
              conversations.length - RECENT_CONVERSATION_LIMIT;

            return (
              <section
                key={projectWorkspace}
                role="group"
                aria-label={projectWorkspace}
                className={s.projectGroup}
              >
                <div className={s.projectHeading}>
                  <div className={s.projectTitle}>
                    <button
                      className={s.projectCollapseButton}
                      aria-label={`${projectCollapsed ? "展开" : "折叠"} ${projectName} 的对话`}
                      aria-expanded={!projectCollapsed}
                      onClick={() => toggleProjectHistory(projectWorkspace)}
                      title={`${projectCollapsed ? "展开" : "折叠"}此项目的全部对话`}
                    >
                      <span aria-hidden="true">
                        {projectCollapsed ? "›" : "⌄"}
                      </span>
                    </button>
                    <strong title={projectWorkspace}>{projectName}</strong>
                    <span className={s.projectCount}>
                      {conversations.length}
                    </span>
                    <button
                      className={s.projectNewButton}
                      disabled={busy}
                      onClick={() => void createConversation(projectWorkspace)}
                      aria-label="新建对话"
                      title="以主目录当前状态新建 Riftri 对话"
                    >
                      <span>＋</span>
                    </button>
                    <button
                      className={s.projectNewButton}
                      disabled={busy}
                      aria-label="新建 Worktree 对话"
                      title="从 Git 提交创建独立工作目录"
                      onClick={() => {
                        setWorktreeProject(projectWorkspace);
                        setMobileSidebarOpen(false);
                      }}
                    >
                      ⑂
                    </button>
                  </div>
                  <small
                    className={s.projectWorkspace}
                    title={projectWorkspace}
                  >
                    {projectWorkspace}
                  </small>
                </div>
                {!projectCollapsed && (
                  <>
                    {visibleConversations.map((item) => (
                      <button
                        key={item.id}
                        aria-label={item.title}
                        title={item.title}
                        aria-current={selected === item.id ? "page" : undefined}
                        className={
                          selected === item.id
                            ? `${s.conversationButton} ${s.selected}`
                            : s.conversationButton
                        }
                        onClick={() => {
                          setSelected(item.id);
                          setError("");
                          setMobileSidebarOpen(false);
                        }}
                      >
                        <span className={s.sessionIcon}>
                          {item.worktree
                            ? item.worktree.mode === "riftri"
                              ? "◈"
                              : "⑂"
                            : "⌘"}
                        </span>
                        <span className={s.conversationTitle}>
                          <strong>{item.title}</strong>
                        </span>
                      </button>
                    ))}
                    {hiddenConversationCount > 0 && (
                      <button
                        className={s.conversationLimitButton}
                        onClick={() =>
                          toggleOlderConversations(projectWorkspace)
                        }
                      >
                        {showOlderConversations
                          ? "收起其他对话"
                          : `展开其他 ${hiddenConversationCount} 个对话`}
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          })}
          {!list.length && (
            <p className={s.emptyList}>
              你的项目与对话
              <br />
              将在这里保存。
            </p>
          )}
        </nav>
        <div className={s.sideFooter}>
          <button
            type="button"
            onClick={() =>
              window.open("/?view=replay", "_blank", "noopener,noreferrer")
            }
          >
            对话阅读器 <span>↗</span>
          </button>
          <button
            disabled={serverState !== "running"}
            onClick={() => {
              setMobileSidebarOpen(false);
              setShowReload(true);
            }}
            title="重启构建后的本机服务并重新加载页面"
          >
            重载服务
          </button>
          <button
            onClick={() => {
              setMobileSidebarOpen(false);
              setShowShutdown(true);
            }}
          >
            关闭服务
          </button>
          <div>
            <span className={s.greenDot} /> 受保护访问{" "}
            <span className={s.version}>v0.1</span>
          </div>
          <button
            aria-haspopup="dialog"
            onClick={() => {
              setMobileSidebarOpen(false);
              setShowSettings(true);
            }}
          >
            ⚙ 模型与设置 <span aria-hidden="true">›</span>
          </button>
        </div>
      </aside>
      {mobileSidebarOpen && (
        <button
          type="button"
          className={s.mobileSidebarBackdrop}
          aria-label="关闭导航抽屉"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <main className={s.main}>
        <header className={s.header}>
          <button
            type="button"
            className={s.mobileMenuButton}
            aria-controls="primary-navigation"
            aria-expanded={mobileSidebarOpen}
            aria-label={mobileSidebarOpen ? "关闭导航菜单" : "打开导航菜单"}
            onClick={() => setMobileSidebarOpen((open) => !open)}
          >
            <span aria-hidden="true">{mobileSidebarOpen ? "×" : "☰"}</span>
          </button>
          <div>
            <span className={s.breadcrumb}>工作台 / </span>
            {loading
              ? selectedSession?.title || "正在打开对话…"
              : data?.session.title || "开始创作"}
          </div>
          <div className={s.headerRight}>
            <span className={s.modelBadge}>{settings?.model || "连接中"}</span>
            <span
              className={s.sandboxBadge}
              title={
                sandbox?.mode === "sandboxed"
                  ? "Agent Runtime 使用专用账户；已有 Everyone 可写 ACL 可能允许它写入实例根以外的对象。Git CLI 与其他命令使用相同权限规则；获批的 run_with_permissions 命令由 Broker 以宿主用户权限执行，不受 Sandbox 附加文件、网络或凭据限制。"
                  : sandbox?.reason
              }
              aria-label={`Runtime 隔离状态：${sandbox?.mode ?? "unknown"}`}
            >
              {sandbox?.mode === "sandboxed"
                ? `Runtime 已隔离${sandbox.level ? `：${sandbox.level}` : ""}`
                : sandbox?.mode === "host-process-fallback"
                  ? "Sandbox 失败：宿主运行"
                  : sandbox?.mode === "non-isolated"
                    ? "未隔离"
                    : sandbox?.failureCategory === "runtime_execution"
                      ? "隔离结果未知"
                      : "隔离待确认"}
            </span>
            <span className={s.status}>
              {active
                ? active.status === "queued"
                  ? "排队中"
                  : active.status === "waiting"
                    ? "等待确认"
                    : "执行中"
                : connected
                  ? "就绪"
                  : "重新连接中"}
            </span>
          </div>
        </header>
        {error && (
          <div role="alert" className={s.errorBanner}>
            {error}
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        {!hasKey && settings && (
          <div className={s.keyBanner}>
            配置模型密钥后，即可开始编码任务。
            <button
              aria-haspopup="dialog"
              onClick={() => setShowSettings(true)}
            >
              打开设置 →
            </button>
          </div>
        )}
        {data && !loading && <SessionStatistics data={data} />}
        <div
          ref={scrollArea}
          className={s.scrollArea}
          style={{ overflowAnchor: "none" }}
        >
          {addingProject || !selected ? (
            <section className={s.welcome}>
              <div className={s.eyebrow}>IDEAS INTO WORKING CODE</div>
              <h1>
                让想法，
                <br />
                <span>在代码中成形。</span>
              </h1>
              <p>
                连接一个本地项目，一起阅读、修改和验证代码。
                <br />
                每一步执行清晰可见，每一次对话留在本机。
              </p>
              <form className={s.projectForm} onSubmit={createProject}>
                <p>
                  默认使用 Riftri
                  创建独立工作视图，包含主目录的未提交与忽略文件。Windows 需要
                  WinFsp，未修改文件实时读取主目录；Linux/macOS 需要原生 CoW。
                </p>
                <label>
                  项目目录
                  <input
                    autoFocus
                    required
                    value={workspace}
                    placeholder="例如 G:\\projects\\my-app 或 /Users/me/my-app"
                    onChange={(e) => setWorkspace(e.target.value)}
                  />
                </label>
                <div>
                  <button disabled={busy} className={s.primary}>
                    {busy ? "连接中…" : "连接项目并新建对话"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !workspace.trim()}
                    onClick={() => setWorktreeProject(workspace)}
                  >
                    改用 Git worktree
                  </button>
                  {list.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAddingProject(false)}
                    >
                      取消
                    </button>
                  )}
                </div>
              </form>
              <div className={s.cards}>
                <article>
                  <span>01 / UNDERSTAND</span>
                  <h3>理解项目</h3>
                  <p>阅读目录、搜索代码，找到问题所在。</p>
                </article>
                <article>
                  <span>02 / BUILD</span>
                  <h3>精确修改</h3>
                  <p>小步调整代码，清楚查看每一处差异。</p>
                </article>
                <article>
                  <span>03 / VERIFY</span>
                  <h3>验证结果</h3>
                  <p>运行测试与构建，让结果有据可查。</p>
                </article>
              </div>
              <div className={s.welcomeFoot}>
                本地工作区 <i /> 跨目录并行 <i /> 同目录串行 <i /> 操作按需确认
              </div>
            </section>
          ) : loading ? (
            <section
              className={s.sessionEmpty}
              role="status"
              aria-live="polite"
            >
              <span>⌘</span>
              <h2>正在打开对话…</h2>
              <p>正在读取这段对话的本地历史；当前任务不会被重新提交。</p>
            </section>
          ) : (
            <>
              <div className={s.projectBar}>
                <span>⌁</span>
                <span title={workspaceDescription(data?.session.worktree)}>
                  {data?.session.worktree
                    ? data.session.worktree.mode === "riftri"
                      ? "Riftri"
                      : "Worktree"
                    : "本地项目（历史）"}
                </span>
                <code title={data?.session.workspace}>
                  {data?.session.workspace}
                </code>
              </div>
              {data?.history &&
                (olderError || loadingOlder || data.history.hasOlder) && (
                  <div
                    className={olderError ? s.historyError : s.historyStatus}
                    role={olderError ? "alert" : "status"}
                  >
                    {olderError ? (
                      <>
                        <span>{olderError}</span>
                        <button onClick={() => void loadOlder()}>
                          重试加载历史
                        </button>
                      </>
                    ) : loadingOlder ? (
                      "正在加载更早记录…"
                    ) : (
                      "向上滚动查看更早记录"
                    )}
                  </div>
                )}
              {data && (
                <Timeline
                  key={data.session.id}
                  data={data}
                  onError={setError}
                  scrollContainerRef={scrollArea}
                />
              )}
              {data && !data.events.length && (
                <div className={s.sessionEmpty}>
                  <span>✳</span>
                  <h2>从一个具体的任务开始</h2>
                  <p>例如：解释项目结构，或修复一个 bug 并补充测试。</p>
                </div>
              )}
            </>
          )}
        </div>
        {selected && !loading && (
          <footer className={s.composerWrap}>
            {!active &&
              recoverable &&
              ["failed", "cancelled", "interrupted"].includes(
                recoverable.status,
              ) && (
                <div className={s.notice}>
                  <p>
                    {recoverable.error || "任务中断"}{" "}
                    可在下方填写恢复说明，或直接恢复。
                  </p>
                  <button
                    disabled={busy || !hasKey}
                    onClick={() => void resume()}
                  >
                    恢复任务
                  </button>
                </div>
              )}
            <div className={s.composer}>
              <MarkdownTaskEditor
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => {
                  if (!active && !busy) {
                    void send();
                  }
                }}
              />
              <div className={s.composerActions}>
                {subagentsAvailable && (
                  <label
                    className={s.subagentChoice}
                    title="允许主 agent 使用多个 explorer/reviewer，可能增加模型用量；不授予子代理写入权限。"
                  >
                    <input
                      type="checkbox"
                      checked={
                        active ? active.subagentsEnabled : subagentsEnabled
                      }
                      disabled={Boolean(active) || busy}
                      onChange={(event) =>
                        setSubagentsEnabled(event.target.checked)
                      }
                    />
                    启用 subagent（只读）
                  </label>
                )}
                <span>↵ 发送 · Shift + ↵ 换行</span>
                {active ? (
                  <button
                    className={s.stop}
                    onClick={() =>
                      api("/tasks/" + active.id + "/cancel", {}).catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    ■ 停止任务
                  </button>
                ) : (
                  <button
                    className={s.primary}
                    disabled={busy || !prompt.trim() || !hasKey}
                    onClick={() => void send()}
                  >
                    开始执行 ↑
                  </button>
                )}
              </div>
            </div>
          </footer>
        )}
      </main>
      {worktreeProject && (
        <WorktreeDialog
          workspace={worktreeProject}
          onClose={() => setWorktreeProject(undefined)}
          onCreated={(session) => {
            setList((current) => [
              session,
              ...current.filter((item) => item.id !== session.id),
            ]);
            setSelected(session.id);
            setAddingProject(false);
            setWorktreeProject(undefined);
            setError("");
          }}
        />
      )}
      {showReload && (
        <div className={s.overlay}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="重载服务确认"
            className={s.modal}
          >
            <h2>重载 CodeAtelier 服务？</h2>
            <p>
              服务会停止当前任务并保存为可恢复的中断状态，然后重新启动并重新加载此页面。已修改的文件不会撤销。
            </p>
            <p>重载只载入已构建的产物；源码变更请先执行 pnpm build。</p>
            <div className={s.actions}>
              <button
                disabled={serverState === "reloading"}
                onClick={() => setShowReload(false)}
              >
                暂不重载
              </button>
              <button
                className={s.primary}
                disabled={serverState === "reloading"}
                onClick={() => void reloadService()}
              >
                {serverState === "reloading" ? "正在重载…" : "确认重载服务"}
              </button>
            </div>
          </section>
        </div>
      )}
      {showShutdown && (
        <div className={s.overlay}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="关闭服务确认"
            className={s.modal}
          >
            <h2>关闭 CodeAtelier 服务？</h2>
            <p>
              所有页面将断开连接。正在执行或排队的任务会停止并保存为可恢复的中断状态，已修改的文件不会撤销。
            </p>
            <p>重新启动需在项目目录运行 pnpm start。</p>
            <div className={s.actions}>
              <button
                disabled={serverState === "stopping"}
                onClick={() => setShowShutdown(false)}
              >
                暂不关闭
              </button>
              <button
                className={s.primary}
                disabled={serverState === "stopping"}
                onClick={() => void stopServer()}
              >
                {serverState === "stopping" ? "正在关闭…" : "确认关闭服务"}
              </button>
            </div>
          </section>
        </div>
      )}
      {showSettings && settings && (
        <SettingsPage
          onClose={() => setShowSettings(false)}
          onSaved={(v) => {
            setSettings(v.settings);
            setHasKey(v.hasApiKey);
          }}
        />
      )}
    </div>
  );
}

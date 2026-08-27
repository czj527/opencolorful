import { useEffect, useRef, useState } from "react";

import { Timeline } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { Dock, DockToggleButtons, type DockTool } from "./components/Dock.js";
import type { AssistantStatus } from "./components/AgentCard.js";
import { OnboardingPage } from "./components/OnboardingPage.js";
import { SettingsModal, type SettingsCategory } from "./components/SettingsModal.js";
import { Sidebar, SidebarRail } from "./components/Sidebar.js";
import { Titlebar, type PageId } from "./components/Titlebar.js";
import { UsageBadge } from "./components/UsageBadge.js";
import { WorkspaceBanner } from "./components/WorkspaceBanner.js";
import {
  createDataSource,
  type ConnectionInfo,
  type DesktopDataSource,
  type ModelOption,
  type ModelRef,
  type PreferencesView,
  type SessionSettingsView,
  type SessionUsageView,
} from "./data/source.js";
import type { Agent, Thread, TimelineItem } from "./mock-data.js";
import { toUserError, type ErrorContext } from "./errors.js";
import { AgentProfilePage } from "./pages/AgentProfilePage.js";
import { MemoryPage } from "./pages/MemoryPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import { useTheme } from "./theme.js";
import { useFirstRun } from "./use-first-run.js";

const NEW_THREAD = "new";

/** 偏好接口缺失/不可用时的兜底：与后端默认一致，模型选择退回“首个已配置” */
const FALLBACK_PREFERENCES: PreferencesView = {
  defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" },
};

export function App() {
  const theme = useTheme();
  const [source, setSource] = useState<DesktopDataSource | null>(null);
  const [page, setPage] = useState<PageId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<readonly Thread[]>([]);
  const [threadId, setThreadId] = useState<string>(NEW_THREAD);
  const [items, setItems] = useState<readonly TimelineItem[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<React.ReactNode | null>(null);
  const [dock, setDock] = useState<DockTool | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const [sessionSettings, setSessionSettings] = useState<SessionSettingsView | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageView | null>(null);
  const [confirming, setConfirming] = useState(false);
  // 新会话（未落库）时的本地选择；创建会话时下发到服务端。
  // 初始对齐后端偏好默认（read-only / medium），偏好加载后再微调
  const [draftModel, setDraftModel] = useState<ModelRef | null>(null);
  const [draftThinking, setDraftThinking] = useState("medium");
  const [draftToolMode, setDraftToolMode] = useState("read-only");
  const [preferences, setPreferences] = useState<PreferencesView | null>(null);
  // 偏好加载后不覆盖用户已做的手动选择（记录是否触碰过草稿运行设置）
  const touchedThinking = useRef(false);
  const touchedToolMode = useRef(false);
  // 连接状态（台账 #12）：数据源探活/请求结果驱动，断线时 Titlebar 离线指示
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  // T0 首启检测：无 Agent 或无已配置凭据的 Provider → 自动进入引导（可退出；状态派生自后端，不落库）
  const firstRun = useFirstRun(source);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // 启动：探测真实后端（IPC 桥），不可达回退 mock
  useEffect(() => {
    let cancelled = false;
    void createDataSource().then((next) => {
      if (!cancelled) setSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 连接状态订阅：ipc 为动态探活，mock 为静态一次性回调
  useEffect(() => {
    if (source === null) return;
    setConnection(source.info);
    if (source.subscribeConnection === undefined) return;
    return source.subscribeConnection(setConnection);
  }, [source]);

  // Agent 列表（onboarding 创建新助理后通过 agentsRefresh 重拉）
  const [agentsRefresh, setAgentsRefresh] = useState(0);
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    source.listAgents().then((list) => {
      if (cancelled) return;
      setAgents(list);
      setAgentId((current) => (current !== "" && list.some((agent) => agent.id === current)) ? current : list[0]?.id ?? "");
    }).catch(() => {
      if (!cancelled) setAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, [source, agentsRefresh]);

  const activeAgent = agents.find((agent) => agent.id === agentId) ?? agents[0];

  useEffect(() => {
    if (activeAgent !== undefined) source?.setActiveAgentName?.(activeAgent.name);
  }, [source, activeAgent]);

  // 全局偏好：草稿运行设置与默认模型的偏好来源（加载前草稿先用 medium/read-only 兜底）
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    const load = source.getPreferences === undefined
      ? Promise.resolve(null)
      : source.getPreferences().catch(() => null);
    load.then((value) => {
      if (cancelled) return;
      setPreferences(value ?? FALLBACK_PREFERENCES);
      if (value === null) return; // 接口缺失/失败：保持兜底默认
      if (!touchedThinking.current) setDraftThinking(value.defaults.thinkingLevel);
      if (!touchedToolMode.current) setDraftToolMode(value.defaults.toolMode);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // 可用模型（真实数据源下来自已配置凭据的 Provider；Provider 变更后重拉）
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    source.listModels().then((list) => {
      if (cancelled) return;
      setModels(list);
      // 偏好未就绪时不自动选模型：避免先落到首个可用、偏好加载后被“当前值仍在列表”保留
      if (preferences === null) return;
      setDraftModel((current) => {
        // ① 当前选择仍在列表则保持（含用户手动选择）
        if (current !== null && list.some((option) => option.providerId === current.providerId && option.modelId === current.modelId)) return current;
        // ② 偏好默认模型在列表且已配置凭据 → 优先采用
        const preferred = preferences.defaults.model;
        if (preferred !== null) {
          const fromPref = list.find((option) => option.credentialConfigured && option.providerId === preferred.providerId && option.modelId === preferred.modelId);
          if (fromPref !== undefined) return { providerId: fromPref.providerId, modelId: fromPref.modelId };
        }
        // ③ 偏好缺失/不可用 → 第一个已配置凭据的模型；④ 都没有 → null
        const first = list.find((option) => option.credentialConfigured);
        return first !== undefined ? { providerId: first.providerId, modelId: first.modelId } : null;
      });
    }).catch(() => {
      if (!cancelled) setModels([]);
    });
    return () => {
      cancelled = true;
    };
  }, [source, modelsRefresh, preferences]);

  const isNew = threadId === NEW_THREAD;

  // 会话设置与用量（真实会话才拉取；新会话用本地草稿值）
  useEffect(() => {
    if (source === null || isNew) {
      setSessionSettings(null);
      setSessionUsage(null);
      return;
    }
    let cancelled = false;
    source.getSessionSettings(threadId).then((settings) => {
      if (!cancelled) setSessionSettings(settings);
    }).catch(() => {
      if (!cancelled) setSessionSettings(null);
    });
    source.getSessionUsage(threadId).then((usage) => {
      if (!cancelled) setSessionUsage(usage);
    }).catch(() => {
      if (!cancelled) setSessionUsage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [source, threadId, isNew]);

  // 一轮对话结束后刷新用量
  const wasStreaming = useRef(false);
  useEffect(() => {
    const finished = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (!finished || source === null || isNew) return;
    source.getSessionUsage(threadId).then(setSessionUsage).catch(() => undefined);
  }, [streaming, source, threadId, isNew]);

  // 当前 Agent 的会话列表（含归档区）
  useEffect(() => {
    if (source === null || agentId === "") return;
    let cancelled = false;
    Promise.all([
      source.listThreads(agentId),
      source.listArchivedThreads(agentId),
    ]).then(([list, archived]) => {
      if (cancelled) return;
      setThreads(list);
      setArchivedThreads(archived);
      setThreadId((current) => {
        if (list.some((thread) => thread.id === current)) return current;
        return list[0]?.id ?? NEW_THREAD;
      });
    }).catch(() => {
      if (!cancelled) {
        setThreads([]);
        setArchivedThreads([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source, agentId]);

  // 会话时间线订阅（含历史投影与实时事件）
  useEffect(() => {
    if (source === null) return;
    if (threadId === NEW_THREAD) {
      setItems([]);
      setStreaming(false);
      return;
    }
    return source.subscribeChat(threadId, (snapshot) => {
      setItems(snapshot.items);
      setStreaming(snapshot.streaming);
    });
  }, [source, threadId]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  async function send() {
    if (source === null || agentId === "") return;
    const text = draft.trim();
    if (text === "" || streaming) return;
    setChatError(null);

    // 断线 / 离线时明确提示，不静默失败（仅 IPC 真实数据源；mock 模式仍可本地演示）
    const currentConnection = connection ?? source.info;
    if (currentConnection.mode === "ipc" && !currentConnection.connected) {
      setChatError(userErrorNode(new Error("offline"), "send"));
      return;
    }

    if (text === "/compact") {
      if (threadId === NEW_THREAD) {
        setChatError("先发送消息创建会话");
        return;
      }
      setDraft("");
      try {
        await source.compactSession(threadId);
      } catch (cause) {
        setChatError(userErrorNode(cause, "compact"));
      }
      return;
    }

    // 没有已配置凭据的模型时给出配置入口
    const hasUsableModel = models.some((option) => option.credentialConfigured);
    if (!hasUsableModel) {
      setChatError(userErrorNode(new Error("未配置模型"), "send"));
      return;
    }

    setDraft("");
    try {
      let target = threadId;
      if (target === NEW_THREAD) {
        const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        const thread = await source.createThread(agentId, title);
        setThreads((current) => [thread, ...current]);
        target = thread.id;
        // 新会话创建后下发本地选择的模型与运行设置（失败不阻塞首条消息）
        if (draftModel !== null) await source.updateSessionModel(thread.id, draftModel).catch(() => undefined);
        await source.updateSessionSettings(thread.id, { thinkingLevel: draftThinking, toolMode: draftToolMode }).catch(() => undefined);
        setThreadId(thread.id);
      }
      await source.sendPrompt(target, text);
    } catch (cause) {
      setChatError(userErrorNode(cause, "send"));
    }
  }

  function stopStreaming() {
    if (source !== null && threadId !== NEW_THREAD) void source.abort(threadId);
  }

  function selectThread(id: string) {
    setThreadId(id);
    setPage("chat");
  }

  function startNewThread() {
    setThreadId(NEW_THREAD);
    setDraft("");
    setPage("chat");
  }

  function updateThreadTitle(sessionId: string, title: string) {
    if (source === null) return;
    setThreads((current) => current.map((thread) => (thread.id === sessionId ? { ...thread, title } : thread)));
    void source.updateThreadTitle(sessionId, title)
      .then(() => {
        if (agentId === "") return;
        source.listThreads(agentId).then(setThreads).catch(() => undefined);
      })
      .catch((cause: unknown) => {
        setChatError(userErrorNode(cause, "renameThread"));
      });
  }

  function unarchiveThread(sessionId: string) {
    if (source === null) return;
    void source.unarchiveThread(sessionId)
      .then(() => {
        if (agentId === "") return;
        Promise.all([source.listThreads(agentId), source.listArchivedThreads(agentId)]).then(([list, archived]) => {
          setThreads(list);
          setArchivedThreads(archived);
        }).catch(() => undefined);
      })
      .catch((cause: unknown) => {
        setChatError(userErrorNode(cause, "unarchiveThread"));
      });
  }

  function toggleDock(tool: DockTool) {
    setDock((current) => (current === tool ? null : tool));
  }

  /* ---- 会话设置变更（既有会话直接写服务端并本地乐观更新；新会话记草稿） ---- */

  function changeModel(next: ModelRef) {
    if (isNew) {
      setDraftModel(next);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, model: next }));
    void source?.updateSessionModel(threadId, next).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeModel")));
  }

  function changeThinkingLevel(level: string) {
    if (isNew) {
      touchedThinking.current = true;
      setDraftThinking(level);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, thinkingLevel: level }));
    void source?.updateSessionSettings(threadId, { thinkingLevel: level }).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeThinking")));
  }

  function changeToolMode(mode: string) {
    if (isNew) {
      touchedToolMode.current = true;
      setDraftToolMode(mode);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, toolMode: mode }));
    void source?.updateSessionSettings(threadId, { toolMode: mode }).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeTool")));
  }

  function confirmWorkspace() {
    if (source === null || isNew) return;
    setConfirming(true);
    source.updateSessionSettings(threadId, { workspaceConfirmed: true })
      .then(() => setSessionSettings((current) => (current === null ? current : { ...current, workspaceConfirmed: true })))
      .catch((cause: unknown) => setChatError(userErrorNode(cause, "confirmWorkspace")))
      .finally(() => setConfirming(false));
  }

  function switchToReadOnly() {
    if (source === null || isNew) return;
    setConfirming(true);
    source.updateSessionSettings(threadId, { toolMode: "read-only" })
      .then(() => setSessionSettings((current) => (current === null ? current : { ...current, toolMode: "read-only" })))
      .catch((cause: unknown) => setChatError(userErrorNode(cause, "switchReadOnly")))
      .finally(() => setConfirming(false));
  }

  /** 把底层异常转成带下一步动作的中文错误节点 */
  function userErrorNode(cause: unknown, context: ErrorContext): React.ReactNode {
    const { message, action } = toUserError(cause, context);
    if (action === undefined) return message;
    return (
      <>
        {message}
        <button
          type="button"
          className="inline-action"
          onClick={() => {
            setSettingsCategory(action.category);
            setSettingsOpen(true);
          }}
        >
          {action.label}
        </button>
      </>
    );
  }

  if (source === null) {
    return (
      <div className="app">
        <div className="boot-screen">正在连接 OpenColorful 后端…</div>
      </div>
    );
  }

  // 显式进入（空态入口）或首启自动进入；退出后本次运行内不再自动弹出
  const showOnboarding = page === "onboarding" || (firstRun.status === "first-run" && !onboardingDismissed);

  // T4 身份证卡状态行：仅由真实运行时状态推导（离线 > 运行中 > 空闲），不虚构
  const assistantStatus: AssistantStatus = (() => {
    const conn = connection ?? source.info;
    if (!conn.connected) return { label: "离线", tone: "offline" };
    if (streaming) return { label: "运行中", tone: "busy" };
    return { label: "空闲", tone: "ok" };
  })();

  function enterOnboarding() {
    setOnboardingDismissed(false);
    setPage("onboarding");
  }

  function exitOnboarding() {
    setOnboardingDismissed(true);
    setPage("chat");
  }

  // T1 向导完成：重拉 Agent 列表、选中新助理、进入新会话草稿；首启状态随真实数据自然消失
  function completeOnboarding(newAgentId: string) {
    setOnboardingDismissed(true);
    firstRun.refresh();
    setAgentsRefresh((value) => value + 1);
    setAgentId(newAgentId);
    setThreadId(NEW_THREAD);
    setPage("chat");
  }

  const activeThread = threads.find((thread) => thread.id === threadId);
  const isNewThread = threadId === NEW_THREAD;
  const chatTitle = isNewThread ? "新会话" : activeThread?.title ?? "会话";
  const showEmptyState = page === "chat" && isNewThread;
  const workspaceLabel = activeAgent?.workspace ?? "未设置工作目录";

  const composerControls = {
    models,
    model: isNewThread ? draftModel : sessionSettings?.model ?? draftModel,
    onModel: changeModel,
    thinkingLevel: isNewThread ? draftThinking : sessionSettings?.thinkingLevel ?? draftThinking,
    onThinkingLevel: changeThinkingLevel,
    toolMode: isNewThread ? draftToolMode : sessionSettings?.toolMode ?? draftToolMode,
    onToolMode: changeToolMode,
    workspace: activeAgent?.workspace ?? null,
  } as const;

  const showWorkspaceBanner = !showEmptyState
    && sessionSettings !== null
    && sessionSettings.toolMode === "all"
    && !sessionSettings.workspaceConfirmed;

  return (
    <div className="app">
      <Titlebar
        page={page}
        onPage={setPage}
        theme={theme}
        streaming={streaming}
        connection={connection ?? source.info}
      />
      {showOnboarding ? (
        <OnboardingPage source={source} onExit={exitOnboarding} onComplete={completeOnboarding} />
      ) : (
      <div className="app-body">
        {sidebarCollapsed ? (
          <SidebarRail
            agents={agents}
            activeAgent={activeAgent}
            onAgent={setAgentId}
            onExpand={() => setSidebarCollapsed(false)}
            onNewThread={startNewThread}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <Sidebar
            agents={agents}
            activeAgent={activeAgent}
            onAgent={setAgentId}
            threads={threads}
            archivedThreads={archivedThreads}
            activeThreadId={threadId}
            onThread={selectThread}
            onNewThread={startNewThread}
            onUpdateThreadTitle={updateThreadTitle}
            onUnarchiveThread={unarchiveThread}
            onCollapse={() => setSidebarCollapsed(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenAssistantProfile={() => setPage("profile")}
            assistantStatus={assistantStatus}
          />
        )}
        <main className="main">
          {page === "chat" && (
            <section className="chat-page">
              {!showEmptyState && (
                <header className="chat-head">
                  <div className="chat-head-title">
                    <strong>{chatTitle}</strong>
                    <span>{(activeAgent?.name ?? "Agent")} · {workspaceLabel}</span>
                  </div>
                  {sessionUsage !== null && <UsageBadge usage={sessionUsage} />}
                  <DockToggleButtons dock={dock} onToggle={toggleDock} />
                </header>
              )}
              {showWorkspaceBanner && (
                <WorkspaceBanner
                  cwd={sessionSettings.workspaceCwd}
                  busy={confirming}
                  onConfirm={confirmWorkspace}
                  onReadOnly={switchToReadOnly}
                />
              )}
              <div className="chat-scroll">
                {showEmptyState ? (
                  <div className="empty-state">
                    {activeAgent === undefined ? (
                      <>
                        <h1>还没有可用的 Agent</h1>
                        <p className="page-empty">跟随引导创建你的第一个助理并接入模型，两分钟即可开始对话。</p>
                        <button type="button" className="btn btn-primary" onClick={enterOnboarding}>开始引导</button>
                      </>
                    ) : (
                      <>
                        <span className="empty-agent" style={{ background: activeAgent.color }} aria-hidden="true">
                          {activeAgent.initial}
                        </span>
                        <h1>要做什么，交给{activeAgent.name}吧</h1>
                        <p className="page-empty">新会话为草稿：发送首条消息后才会出现在会话列表</p>
                        <div className="empty-agents">
                          {agents.map((agent) => (
                            <button
                              key={agent.id}
                              type="button"
                              className={agent.id === agentId ? "is-active" : ""}
                              onClick={() => setAgentId(agent.id)}
                            >
                              <span className="agent-dot" style={{ background: agent.color, width: 16, height: 16, fontSize: 9 }} aria-hidden="true">{agent.initial}</span>
                              {agent.name}
                            </button>
                          ))}
                        </div>
                        <div className="empty-composer">
                          <Composer
                            agentName={activeAgent.name}
                            draft={draft}
                            onDraft={setDraft}
                            onSend={() => void send()}
                            onStop={stopStreaming}
                            streaming={streaming}
                            autoFocus
                            {...composerControls}
                          />
                        </div>
                        {models.length > 0 && !models.some((option) => option.credentialConfigured) && (
                          <button
                            type="button"
                            className="inline-action"
                            onClick={() => {
                              setSettingsCategory("models");
                              setSettingsOpen(true);
                            }}
                          >
                            还没有可用模型，去配置 Provider 与 API Key →
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <Timeline items={items} onOpenDiff={() => setDock("diff")} />
                )}
              </div>
              {!showEmptyState && (
                <div className="chat-composer">
                  {chatError !== null && <div className="chat-error" role="alert">{chatError}</div>}
                  <Composer
                    agentName={activeAgent?.name ?? "Agent"}
                    draft={draft}
                    onDraft={setDraft}
                    onSend={() => void send()}
                    onStop={stopStreaming}
                    streaming={streaming}
                    {...composerControls}
                  />
                </div>
              )}
            </section>
          )}
          {page === "memory" && activeAgent !== undefined && (
            <div className="page-scroll"><MemoryPage source={source} agent={activeAgent} /></div>
          )}
          {page === "logs" && <div className="page-scroll"><LogsPage source={source} /></div>}
          {page === "profile" && activeAgent !== undefined && (
            <div className="page-scroll"><AgentProfilePage agent={activeAgent} source={source} /></div>
          )}
        </main>
        {page === "chat" && dock !== null && (
          <Dock
            tool={dock}
            onSelect={setDock}
            onClose={() => setDock(null)}
            subagent={activeAgent === undefined ? undefined : {
              source,
              agentId: activeAgent.id,
              sessionId: isNewThread ? null : threadId,
            }}
          />
        )}
      </div>
      )}
      {settingsOpen && (
        <SettingsModal
          category={settingsCategory}
          onCategory={setSettingsCategory}
          onClose={() => setSettingsOpen(false)}
          themeMode={theme.mode}
          onThemeMode={theme.setMode}
          dataSourceLabel={source.info.label}
          source={source}
          onProvidersChanged={() => setModelsRefresh((value) => value + 1)}
        />
      )}
    </div>
  );
}

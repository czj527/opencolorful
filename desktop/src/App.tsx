import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentChip } from "./components/AgentChip.js";
import { AgentIdCard, type AssistantStatus } from "./components/AgentIdCard.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { Dock, DockToggleButtons, type DockTool } from "./components/Dock.js";
import { MockBanner } from "./components/MockBanner.js";
import { NewAgentDialog } from "./components/NewAgentDialog.js";
import { NewSessionDialog } from "./components/NewSessionDialog.js";
import { OnboardingPage } from "./components/OnboardingPage.js";
import { SettingsModal, type SettingsCategory } from "./components/SettingsModal.js";
import { Sidebar, SidebarRail } from "./components/Sidebar.js";
import { Titlebar, type PageId } from "./components/Titlebar.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
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
import type { Agent, Thread } from "./mock-data.js";
import { useLocalPrefs } from "./data/local-prefs.js";
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

/**
 * T9 会话中心 IA：不再有全局"当前助理"。
 * - 会话列表跨助理展示，行内 badge 自标识归属（≥2 助理时）；
 * - `draftAgentId` 只表示"新会话归属"的用户显式选择（"" = 自动推导：最近会话的助理 → 首个助理）；
 * - 已落库会话的助理由 thread.agentId 决定，会话头 chip 只读、点击进档案页；
 * - 档案页/记忆页各自持有目标助理（profileAgentId / memoryAgentId）。
 */
export function App() {
  const theme = useTheme();
  const localPrefs = useLocalPrefs();

  // 减少动效（T8）：html data 属性驱动 CSS gate；系统级 prefers-reduced-motion 由 media query 独立兜底
  useEffect(() => {
    if (localPrefs.reduceMotion) {
      document.documentElement.dataset["reduceMotion"] = "true";
    } else {
      delete document.documentElement.dataset["reduceMotion"];
    }
  }, [localPrefs.reduceMotion]);

  const [source, setSource] = useState<DesktopDataSource | null>(null);
  const [page, setPage] = useState<PageId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  // 新会话归属的显式选择；"" 表示未选，走自动推导（最近会话助理 → 首个助理）
  const [draftAgentId, setDraftAgentId] = useState("");
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<readonly Thread[]>([]);
  const [threadId, setThreadId] = useState<string>(NEW_THREAD);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<React.ReactNode | null>(null);
  const [dock, setDock] = useState<DockTool | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  // 设置页保存全局偏好后 +1，驱动 preferences 重拉（草稿运行设置与默认模型联动）
  const [prefsRefresh, setPrefsRefresh] = useState(0);
  const [sessionSettings, setSessionSettings] = useState<SessionSettingsView | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageView | null>(null);
  const [confirming, setConfirming] = useState(false);
  // T3：高级新建会话弹窗
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // T9：新建助理弹窗
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  // 档案页 / 记忆页各自的目标助理（"" = 跟随草稿助理推导）
  const [profileAgentId, setProfileAgentId] = useState("");
  const [memoryAgentId, setMemoryAgentId] = useState("");
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
  // G2 T2：应用内更新状态（驱动 UpdateBanner；设置页 about 另行自订阅）
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);

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

  // Agent 列表（onboarding/新建助理后通过 agentsRefresh 重拉）
  const [agentsRefresh, setAgentsRefresh] = useState(0);
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    source.listAgents().then((list) => {
      if (cancelled) return;
      setAgents(list);
      // 显式选择的助理被删除等失效场景：回退自动推导
      setDraftAgentId((current) => (current !== "" && !list.some((agent) => agent.id === current)) ? "" : current);
    }).catch(() => {
      if (!cancelled) setAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, [source, agentsRefresh]);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const showAgentBadge = agents.length >= 2;

  // 草稿助理推导：显式选择 > 最近会话的助理 > 首个助理（T9：不靠全局切换器，靠上下文）
  const draftAgent = useMemo(() => {
    const explicit = agentsById.get(draftAgentId);
    if (explicit !== undefined) return explicit;
    const fromThread = threads.find((thread) => thread.agentId !== null);
    if (fromThread !== undefined && fromThread.agentId !== null) {
      const byThread = agentsById.get(fromThread.agentId);
      if (byThread !== undefined) return byThread;
    }
    return agents[0];
  }, [agents, agentsById, draftAgentId, threads]);

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
  }, [source, prefsRefresh]);

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

  // 全量会话列表（T9：跨助理，含归档区；行内 badge 标识归属）
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    Promise.all([
      source.listThreads(),
      source.listArchivedThreads(),
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
  }, [source]);

  // App 壳只保留 streaming 布尔，经窄选择器订阅（不回传 items）：仅在布尔翻转时触发
  // App 重渲染（setStreaming 同值自动 bail）。items/完整快照仍由 ChatView 订阅——
  // 两者共享同一 channel，任一订阅存活期间 SSE 流与 projector 持续推进（切页不中断）。
  useEffect(() => {
    if (source === null) return;
    if (threadId === NEW_THREAD) {
      setStreaming(false);
      return;
    }
    return source.subscribeChat(threadId, (snapshot) => {
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

  // G2 T2：更新状态订阅（App 级，驱动 UpdateBanner；无桥=浏览器 dev 不订阅）
  useEffect(() => {
    const bridge = window.desktopUpdate;
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge.getState().then((next) => { if (!cancelled) setUpdateState(next); }).catch(() => undefined);
    const unsubscribe = bridge.onStateChanged((next) => setUpdateState(next));
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const activeThread = threads.find((thread) => thread.id === threadId);
  // 已落库会话的助理由 thread.agentId 决定（历史 null → undefined，不显示 chip）
  const threadAgent = activeThread?.agentId != null ? agentsById.get(activeThread.agentId) : undefined;
  // 会话头展示的助理：草稿态 = 草稿助理（新会话归属）；已落库 = 会话自身助理
  const headerAgent = isNew ? draftAgent : threadAgent;

  // mock 演示源跟随 UI 上下文的助理名（真实数据源从会话归属推导，此方法仅 mock 使用）
  useEffect(() => {
    const name = headerAgent?.name;
    if (name !== undefined) source?.setActiveAgentName?.(name);
  }, [source, headerAgent]);

  function reloadThreads(currentSource: DesktopDataSource) {
    Promise.all([currentSource.listThreads(), currentSource.listArchivedThreads()]).then(([list, archived]) => {
      setThreads(list);
      setArchivedThreads(archived);
    }).catch(() => undefined);
  }

  async function send() {
    if (source === null) return;
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
        if (draftAgent === undefined) {
          setChatError("还没有可用助理，请先完成引导或新建助理");
          return;
        }
        const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        const thread = await source.createThread(draftAgent.id, title);
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

  // T3：从高级新建表单创建会话后，选中新会话并把它设为新会话归属默认
  function completeNewSession(thread: Thread, selectedAgentId: string) {
    setDraftAgentId(selectedAgentId);
    setThreads((current) => [thread, ...current]);
    setThreadId(thread.id);
    setPage("chat");
    setNewSessionOpen(false);
  }

  // T9：新建助理完成：刷新列表并设为新会话归属
  function completeNewAgent(agent: Agent) {
    setNewAgentOpen(false);
    setDraftAgentId(agent.id);
    setAgentsRefresh((value) => value + 1);
  }

  function updateThreadTitle(sessionId: string, title: string) {
    if (source === null) return;
    setThreads((current) => current.map((thread) => (thread.id === sessionId ? { ...thread, title } : thread)));
    void source.updateThreadTitle(sessionId, title)
      .then(() => reloadThreads(source))
      .catch((cause: unknown) => {
        setChatError(userErrorNode(cause, "renameThread"));
      });
  }

  function unarchiveThread(sessionId: string) {
    if (source === null) return;
    void source.unarchiveThread(sessionId)
      .then(() => reloadThreads(source))
      .catch((cause: unknown) => {
        setChatError(userErrorNode(cause, "unarchiveThread"));
      });
  }

  function toggleDock(tool: DockTool) {
    setDock((current) => (current === tool ? null : tool));
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

  /** 进入某个助理的档案页（T9：档案页目标由入口决定，不再有全局当前助理） */
  function openProfile(agent: Agent) {
    setProfileAgentId(agent.id);
    setPage("profile");
  }

  /* ---- 会话设置变更（既有会话直接写服务端并本地乐观更新；新会话记草稿） ---- */

  const changeModel = useCallback((next: ModelRef) => {
    if (isNew) {
      setDraftModel(next);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, model: next }));
    void source?.updateSessionModel(threadId, next).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeModel")));
  }, [isNew, source, threadId]);

  const changeThinkingLevel = useCallback((level: string) => {
    if (isNew) {
      touchedThinking.current = true;
      setDraftThinking(level);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, thinkingLevel: level }));
    void source?.updateSessionSettings(threadId, { thinkingLevel: level }).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeThinking")));
  }, [isNew, source, threadId]);

  const changeToolMode = useCallback((mode: string) => {
    if (isNew) {
      touchedToolMode.current = true;
      setDraftToolMode(mode);
      return;
    }
    setSessionSettings((current) => (current === null ? current : { ...current, toolMode: mode }));
    void source?.updateSessionSettings(threadId, { toolMode: mode }).catch((cause: unknown) => setChatError(userErrorNode(cause, "changeTool")));
  }, [isNew, source, threadId]);

  // 组件隔离：稳定回调使下游 memo（Composer 子组件）在流式刷新期间不被重渲染
  const onOpenDiff = useCallback(() => setDock("diff"), []);

  // 身份证卡状态行：仅由真实运行时状态推导（离线 > 运行中 > 空闲），不虚构
  const assistantStatus = useMemo<AssistantStatus>(() => {
    const conn = connection ?? source?.info ?? null;
    if (conn === null || !conn.connected) return { label: "离线", tone: "offline" };
    if (streaming) return { label: "运行中", tone: "busy" };
    return { label: "空闲", tone: "ok" };
  }, [connection, streaming, source]);

  // chip 状态点更克制：只在"运行中/离线"时出现，空闲不渲染
  const chipStatus = useMemo<AssistantStatus | undefined>(() => {
    const conn = connection ?? source?.info ?? null;
    if (conn !== null && !conn.connected) return { label: "离线", tone: "offline" };
    if (streaming) return { label: "运行中", tone: "busy" };
    return undefined;
  }, [connection, streaming, source]);

  // 会话运行设置组合：流式期间 items 刷新不重建该对象，Composer 免于重渲染
  const composerControls = useMemo(() => ({
    models,
    model: isNew ? draftModel : sessionSettings?.model ?? draftModel,
    onModel: changeModel,
    thinkingLevel: isNew ? draftThinking : sessionSettings?.thinkingLevel ?? draftThinking,
    onThinkingLevel: changeThinkingLevel,
    toolMode: isNew ? draftToolMode : sessionSettings?.toolMode ?? draftToolMode,
    onToolMode: changeToolMode,
    workspace: isNew
      ? draftAgent?.workspace ?? null
      : sessionSettings?.workspaceCwd ?? threadAgent?.workspace ?? null,
  } as const), [isNew, models, draftModel, sessionSettings, draftThinking, draftToolMode, draftAgent, threadAgent, changeModel, changeThinkingLevel, changeToolMode]);

  if (source === null) {
    return (
      <div className="app">
        <div className="boot-screen">正在连接 OpenColorful 后端…</div>
      </div>
    );
  }

  // 显式进入（空态入口）或首启自动进入；退出后本次运行内不再自动弹出
  const showOnboarding = page === "onboarding" || (firstRun.status === "first-run" && !onboardingDismissed);

  function enterOnboarding() {
    setOnboardingDismissed(false);
    setPage("onboarding");
  }

  function exitOnboarding() {
    setOnboardingDismissed(true);
    setPage("chat");
  }

  // T1 向导完成：重拉 Agent 列表、设为新会话归属、进入新会话草稿；首启状态随真实数据自然消失
  function completeOnboarding(newAgentId: string) {
    setOnboardingDismissed(true);
    firstRun.refresh();
    setAgentsRefresh((value) => value + 1);
    setDraftAgentId(newAgentId);
    setThreadId(NEW_THREAD);
    setPage("chat");
  }

  const isNewThread = threadId === NEW_THREAD;
  const chatTitle = isNewThread ? "新会话" : activeThread?.title ?? "会话";
  const showEmptyState = page === "chat" && isNewThread;
  const workspaceLabel = isNewThread
    ? draftAgent?.workspace ?? "未设置工作目录"
    : sessionSettings?.workspaceCwd ?? threadAgent?.workspace ?? "未设置工作目录";

  const profileAgent = agentsById.get(profileAgentId) ?? draftAgent;
  const memoryAgent = agentsById.get(memoryAgentId) ?? draftAgent;

  const showWorkspaceBanner = !showEmptyState
    && sessionSettings !== null
    && sessionSettings.toolMode === "all"
    && !sessionSettings.workspaceConfirmed;

  // G2 T2：下载完成横幅可见性（驱动 has-update-banner 栅格行 + 挂载）
  const showUpdateBanner = updateState !== null && updateState.status === "downloaded" && updateState.newVersion !== null;

  return (
    <div className={[
      "app",
      source.info.mode === "mock" ? "has-mock-banner" : "",
      showUpdateBanner ? "has-update-banner" : "",
    ].filter(Boolean).join(" ")}>
      <Titlebar
        page={page}
        onPage={setPage}
        theme={theme}
        streaming={streaming}
        connection={connection ?? source.info}
      />
      {source.info.mode === "mock" && <MockBanner />}
      {showUpdateBanner && updateState !== null && updateState.newVersion !== null && (
        <UpdateBanner version={updateState.newVersion} />
      )}
      {showOnboarding ? (
        <OnboardingPage source={source} onExit={exitOnboarding} onComplete={completeOnboarding} />
      ) : (
      <div className="app-body">
        {sidebarCollapsed ? (
          <SidebarRail
            onExpand={() => setSidebarCollapsed(false)}
            onNewThread={startNewThread}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <Sidebar
            threads={threads}
            archivedThreads={archivedThreads}
            activeThreadId={threadId}
            agentsById={agentsById}
            showAgentBadge={showAgentBadge}
            onThread={selectThread}
            onNewThread={startNewThread}
            onUpdateThreadTitle={updateThreadTitle}
            onUnarchiveThread={unarchiveThread}
            onCollapse={() => setSidebarCollapsed(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        <main className="main">
          {page === "chat" && (
            <section className="chat-page">
              {!showEmptyState && (
                <header className="chat-head">
                  {headerAgent !== undefined && (
                    <AgentChip
                      agent={headerAgent}
                      status={chipStatus}
                      onOpenProfile={() => openProfile(headerAgent)}
                    />
                  )}
                  <div className="chat-head-title">
                    <strong>{chatTitle}</strong>
                    <span>{workspaceLabel}</span>
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
                    {draftAgent === undefined ? (
                      <>
                        <h1>还没有可用的助理</h1>
                        <p className="page-empty">跟随引导创建你的第一个助理并接入模型，两分钟即可开始对话。</p>
                        <button type="button" className="btn btn-primary" onClick={enterOnboarding}>开始引导</button>
                      </>
                    ) : (
                      <>
                        <AgentIdCard
                          agent={draftAgent}
                          status={assistantStatus}
                          onOpenProfile={() => openProfile(draftAgent)}
                        />
                        <h1>要做什么，交给{draftAgent.name}吧</h1>
                        <p className="page-empty">新会话为草稿：发送首条消息后才会出现在会话列表</p>
                        {showAgentBadge && (
                          <div className="empty-agents">
                            {agents.map((agent) => (
                              <button
                                key={agent.id}
                                type="button"
                                className={agent.id === draftAgent.id ? "is-active" : ""}
                                onClick={() => setDraftAgentId(agent.id)}
                              >
                                <span className="agent-dot" style={{ background: agent.color, width: 16, height: 16, fontSize: 9 }} aria-hidden="true">{agent.initial}</span>
                                {agent.name}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="empty-composer">
                          {chatError !== null && <div className="chat-error" role="alert">{chatError}</div>}
                          <Composer
                            agentName={draftAgent.name}
                            draft={draft}
                            onDraft={setDraft}
                            onSend={() => void send()}
                            onStop={stopStreaming}
                            streaming={streaming}
                            autoFocus
                            {...composerControls}
                          />
                        </div>
                        <div className="empty-actions">
                          <button
                            type="button"
                            className="inline-action"
                            onClick={() => setNewSessionOpen(true)}
                          >
                            高级新建…
                          </button>
                          <button
                            type="button"
                            className="inline-action"
                            onClick={() => setNewAgentOpen(true)}
                          >
                            新建助理…
                          </button>
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
                  <ChatView source={source} threadId={threadId} onOpenDiff={onOpenDiff} onStreamingChange={setStreaming} />
                )}
              </div>
              {!showEmptyState && (
                <div className="chat-composer">
                  {chatError !== null && <div className="chat-error" role="alert">{chatError}</div>}
                  <Composer
                    agentName={headerAgent?.name ?? "Agent"}
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
          {page === "memory" && memoryAgent !== undefined && (
            <div className="page-scroll"><MemoryPage source={source} agent={memoryAgent} agents={agents} onAgent={setMemoryAgentId} /></div>
          )}
          {page === "logs" && <div className="page-scroll"><LogsPage source={source} /></div>}
          {page === "profile" && profileAgent !== undefined && (
            <div className="page-scroll"><AgentProfilePage agent={profileAgent} source={source} /></div>
          )}
        </main>
        {page === "chat" && dock !== null && (
          <Dock
            tool={dock}
            onSelect={setDock}
            onClose={() => setDock(null)}
            subagent={headerAgent === undefined ? undefined : {
              source,
              agentId: headerAgent.id,
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
          source={source}
          models={models}
          preferences={preferences}
          onProvidersChanged={() => setModelsRefresh((value) => value + 1)}
          onPreferencesChanged={() => setPrefsRefresh((value) => value + 1)}
        />
      )}
      {newSessionOpen && draftAgent !== undefined && (
        <NewSessionDialog
          source={source}
          agents={agents}
          agentId={draftAgent.id}
          models={models}
          draftToolMode={draftToolMode}
          draftThinking={draftThinking}
          draftModel={draftModel}
          onCreated={completeNewSession}
          onCreateAgent={() => {
            setNewSessionOpen(false);
            setNewAgentOpen(true);
          }}
          onClose={() => setNewSessionOpen(false)}
        />
      )}
      {newAgentOpen && (
        <NewAgentDialog
          source={source}
          onCreated={completeNewAgent}
          onClose={() => setNewAgentOpen(false)}
        />
      )}
    </div>
  );
}

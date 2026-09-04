import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import type {
  AgentView,
  ModelSummary,
  PreferencesDocument,
} from "../../lib/types.js";
import { MessageComposer } from "../chat/MessageComposer.js";
import { AgentAvatar } from "../agents/AgentAvatar.js";
import { DirectoryPicker } from "../agents/DirectoryPicker.js";
import { navigateToSettingsSection, navigateToWorkspace } from "../../app/page-router.js";
import styles from "./NewSessionPage.module.css";

const DEFAULT_MODEL_REQUIRED_ERROR = "请先在设置的“默认对话”中选择默认模型";
const DEFAULT_MODEL_LOADING_ERROR = "默认模型仍在加载，请稍后重试";

export interface NewSessionPageProps {
  readonly agents: readonly AgentView[];
  readonly api: ApiClient;
  readonly models: readonly ModelSummary[];
  readonly preferences: PreferencesDocument | null;
  readonly onSessionCreated: (sessionId: string) => void;
}

/**
 * 新建会话独立单页（路由 /new）。
 *
 * 草稿语义：页面持有"尚未落库"的草稿状态；用户在创建完成前离开（返回工作台 /
 * 浏览器后退 / 关闭页签）都不会调用 createSession API，草稿直接丢弃。
 *
 * 首条消息创建流程：
 * 1. submitting=true 禁用输入，防止重复触发
 * 2. 若 createdSessionId 已存在（重试场景）→ 直接 POST /api/sessions/:id/messages
 * 3. 否则 → POST /api/sessions { title, cwd, agentId }
 *    - 创建失败 → 保留草稿+选择，error 显示，submitting=false
 *    - 创建成功 → createdSessionId=新id，POST /api/sessions/:id/messages 发首条消息
 *      - Prompt 失败 → 保留 createdSessionId+草稿，error 显示，允许重试（只发 messages）
 *      - Prompt 成功 → onSessionCreated(sessionId)
 */
export function NewSessionPage({
  agents,
  api,
  models,
  preferences,
  onSessionCreated,
}: NewSessionPageProps) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 选 Agent 时自动继承其 settings.defaultCwd；切到"不绑定"不动 cwd（让用户保留已选）
  const handleSelectAgent = useCallback(
    (id: string | null) => {
      setAgentId(id);
      setError(null);
      if (id !== null) {
        const agent = agents.find((a) => a.identity.id === id);
        if (agent?.settings.defaultCwd !== null && agent?.settings.defaultCwd !== undefined) {
          setCwd(agent.settings.defaultCwd);
        }
      }
    },
    [agents],
  );

  const hasCwd = cwd !== null && cwd.trim().length > 0;
  const canSend = !submitting && hasCwd;

  // 全局默认值（NewSessionPage 不暴露模型/思考/工具控件修改入口）
  const defaultToolMode = preferences?.defaults.toolMode ?? "off";
  const defaultThinkingLevel = preferences?.defaults.thinkingLevel ?? "off";
  const defaultModel = preferences?.defaults.model ?? null;

  const handleSend = useCallback(
    async (content: string) => {
      // 防重复：submitting 状态锁，连续点击/快捷键不重复
      if (submitting) return;
      if (!hasCwd) {
        setError("请先选择工作目录");
        return;
      }
      // 只有创建新 Session 时需要主对话默认模型；已有 Session 的 prompt 重试
      // 继续使用已持久化的 Session 模型，不受当前设置变化影响。
      if (createdSessionId === null && preferences === null) {
        setError(DEFAULT_MODEL_LOADING_ERROR);
        return;
      }
      if (createdSessionId === null && defaultModel === null) {
        setError(DEFAULT_MODEL_REQUIRED_ERROR);
        return;
      }
      setSubmitting(true);
      setError(null);

      try {
        let sessionId = createdSessionId;
        if (sessionId === null) {
          // 创建 session：标题空白时用"新会话"
          const sessionTitle = title.trim().length > 0 ? title.trim() : "新会话";
          const settings = agentId !== null ? { agentId } : undefined;
          const session = await api.createSession(sessionTitle, cwd as string, settings);
          sessionId = session.id;
          setCreatedSessionId(sessionId);
        }

        // 发送首条消息
        try {
          await api.sendPrompt(sessionId, content);
          onSessionCreated(sessionId);
        } catch (err) {
          // Prompt 失败：保留 createdSessionId+草稿，允许重试（重试只发 messages）
          setError(err instanceof Error ? err.message : "发送首条消息失败");
          setSubmitting(false);
          return;
        }
      } catch (err) {
        // 创建失败：保留草稿+选择，error 显示
        setError(err instanceof Error ? err.message : "创建会话失败");
        setSubmitting(false);
        return;
      }
    },
    [
      submitting,
      hasCwd,
      createdSessionId,
      preferences,
      defaultModel,
      title,
      agentId,
      cwd,
      api,
      onSessionCreated,
    ],
  );

  // 草稿状态下命令不可用：依赖已有 Session 的命令（/compact /new /abort）安全禁用
  const handleExecuteCommand = useCallback(() => {
    setError("请在创建会话后使用会话命令");
  }, []);

  const handleBack = useCallback(() => {
    // 草稿离开不落库：仅切换路由，不调创建 API；组件卸载即丢弃草稿
    navigateToWorkspace();
  }, []);

  const agentChipClass = styles.agentChip ?? "";
  const agentChipActiveClass = styles.agentChipActive ?? "";
  const showModelSettingsAction = error === DEFAULT_MODEL_REQUIRED_ERROR;

  return (
    <div className={styles.page ?? ""} data-page="session-new">
      <header className={styles.header ?? ""}>
        <button
          type="button"
          className={styles.back ?? ""}
          onClick={handleBack}
          data-testid="new-session-back"
        >
          <ArrowLeft size={14} aria-hidden="true" /> 返回工作台
        </button>
        <h1 className={styles.title ?? ""}>新建会话</h1>
      </header>

      <main className={styles.content ?? ""}>
        {/* Agent 选择：横向色卡列表，可切换，可选"不绑定 Agent" */}
        <section className={styles.section ?? ""} aria-label="Agent 选择">
          <div className={styles.sectionLabel ?? ""}>绑定 Agent（可选）</div>
          <div className={styles.agentRow ?? ""} data-testid="new-session-agent-row">
            <button
              type="button"
              className={`${agentChipClass} ${agentId === null ? agentChipActiveClass : ""}`.trim()}
              onClick={() => handleSelectAgent(null)}
              aria-pressed={agentId === null}
              data-testid="new-session-agent-none"
            >
              <span className={styles.agentNoneAvatar ?? ""}>—</span>
              <span>不绑定 Agent</span>
            </button>
            {agents.map((a) => {
              const active = a.identity.id === agentId;
              return (
                <button
                  key={a.identity.id}
                  type="button"
                  className={`${agentChipClass} ${active ? agentChipActiveClass : ""}`.trim()}
                  onClick={() => handleSelectAgent(a.identity.id)}
                  aria-pressed={active}
                  data-testid={`new-session-agent-${a.identity.id}`}
                >
                  <AgentAvatar agentId={a.identity.id} name={a.identity.name} size="md" />
                  <span>{a.identity.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 工作目录：选 Agent 时自动继承 defaultCwd，可点 DirectoryPicker 更换 */}
        <section className={styles.section ?? ""} aria-label="工作目录">
          <div className={styles.sectionLabel ?? ""}>工作目录（必选）</div>
          <DirectoryPicker api={api} value={cwd} onChange={setCwd} disabled={submitting} />
        </section>

        {/* 标题（可选，空白时用"新会话"） */}
        <section className={styles.section ?? ""} aria-label="会话标题">
          <div className={styles.sectionLabel ?? ""}>标题（可选，留空使用"新会话"）</div>
          <input
            type="text"
            className={styles.titleInput ?? ""}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="新会话"
            aria-label="会话标题"
            disabled={submitting}
            data-testid="new-session-title"
          />
        </section>

        {/* 错误提示 */}
        {error !== null && (
          <div
            className={styles.error ?? ""}
            role="alert"
            data-testid="new-session-error"
          >
            <span className={styles.errorMessage ?? ""}>{error}</span>
            {showModelSettingsAction && (
              <button
                type="button"
                className={styles.settingsAction ?? ""}
                onClick={() => navigateToSettingsSection("defaults")}
                data-testid="new-session-model-settings"
              >
                设置默认模型
              </button>
            )}
          </div>
        )}

        {/* 复用 MessageComposer：不展示模型/思考/工具的修改入口，用全局默认值 */}
        <MessageComposer
          disabled={!canSend}
          running={false}
          onSend={(content) => void handleSend(content)}
          clearOnSend={false}
          showConfigurationControls={false}
          onAbort={() => {}}
          onExecuteCommand={handleExecuteCommand}
          models={models}
          selectedModel={defaultModel}
          onSelectModel={() => {}}
          toolMode={defaultToolMode}
          onToolModeChange={() => {}}
          thinkingLevel={defaultThinkingLevel}
          onThinkingLevelChange={() => {}}
        />
      </main>
    </div>
  );
}

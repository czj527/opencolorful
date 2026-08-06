import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { ApiClient } from "../../lib/api-client.js";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { AgentSkillsViewData } from "../../lib/skill-types.js";
import { LEARNING_POLICY_LABELS } from "./skill-format.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 诊断视图（plans/phase-13.md §5.2 / §14.4）
// shadowed / gated / blocked + blockedReason；按 Agent 查看。
// ═══════════════════════════════════════════════════════════════

export interface SkillDiagnosticsViewProps {
  readonly skillApi: SkillApiClient;
  readonly api: ApiClient;
}

interface AgentOption {
  readonly id: string;
  readonly name: string;
}

export function SkillDiagnosticsView(props: SkillDiagnosticsViewProps) {
  const [agents, setAgents] = useState<readonly AgentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [view, setView] = useState<AgentSkillsViewData | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const list = await props.api.listAgents();
      const options = list.map((agent) => ({
        id: agent.identity.id,
        name: agent.identity?.name ?? agent.identity.id,
      }));
      setAgents(options);
      if (options.length > 0) {
        setAgentId(options[0]?.id ?? "");
      }
    } catch {
      setAgents([]);
    }
  }, [props.api]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const loadView = useCallback(async (targetAgentId: string) => {
    setLoadState("loading");
    try {
      const result = await props.skillApi.listAgentSkills(targetAgentId);
      if (result.status !== "ok" || result.view === undefined) {
        setLoadState("error");
        setError(result.reason ?? "Agent Skill 视图不可用");
        return;
      }
      setView(result.view);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [props.skillApi]);

  useEffect(() => {
    if (agentId === "") return;
    void loadView(agentId);
  }, [agentId, loadView]);

  if (agents.length === 0) {
    return <p className={styles.hint}>没有可用的 Agent（/api/agents 未接线或无 Agent）。诊断视图按 Agent 查看。</p>;
  }

  return (
    <div>
      <div className={styles.row}>
        <select
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          aria-label="选择 Agent"
          className={styles.select ?? undefined}
          data-testid="skill-diag-agent"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void loadView(agentId)}>
          刷新
        </Button>
      </div>
      <p className={styles.hint}>
        学习策略：{LEARNING_POLICY_LABELS[view?.learningPolicy ?? ""] ?? "?"}；已绑定 Bundle：
        {(view?.bundleBindings ?? []).length} 个；override：{Object.keys(view?.overrides ?? {}).length} 项。
      </p>

      {loadState === "loading" && <p className={styles.hint}>加载中…</p>}
      {loadState === "unavailable" && <p className={styles.hint}>Skill 服务未就绪。</p>}
      {loadState === "error" && <div className={styles.errorBlock}>{error}</div>}

      {loadState === "ready" && view !== null && (
        <div className={styles.grid}>
          <ViewCard title={`可见（${view.visible.length}）`} entries={view.visible} tone="ok" />
          <ViewCard title={`shadowed（${view.shadowed.length}）`} entries={view.shadowed} tone="muted" />
          <ViewCard title={`disabled（${view.disabled.length}）`} entries={view.disabled} tone="muted" />
          <ViewCard title={`gated（${view.gated.length}）`} entries={view.gated} tone="danger" showBlockedReason />
        </div>
      )}
      {loadState === "ready" && view !== null && view.diagnostics.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <Activity size={14} aria-hidden="true" />
            <span className={styles.cardTitle}>解析诊断</span>
          </div>
          {view.diagnostics.map((diagnostic, index) => (
            <p className={styles.muted} key={`diag-${index}`}>
              [{diagnostic.code}] {diagnostic.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewCard(props: {
  readonly title: string;
  readonly entries: readonly { readonly skillRefKey: string; readonly displayName: string; readonly selection?: string; readonly blockedReason?: string }[];
  readonly tone: "ok" | "muted" | "danger";
  readonly showBlockedReason?: boolean;
}) {
  return (
    <div className={styles.card} data-testid={`skill-diag-${props.title.split("（")[0]}`}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{props.title}</span>
      </div>
      {props.entries.length === 0 && <p className={styles.muted}>（无）</p>}
      <ul className={styles.list}>
        {props.entries.map((entry) => (
          <li key={entry.skillRefKey} className={styles.bundleRow}>
            <StatusPill tone={props.tone}>{entry.displayName}</StatusPill>
            {entry.selection !== undefined && <span className={styles.muted}>{entry.selection}</span>}
            {props.showBlockedReason && entry.blockedReason !== undefined && entry.blockedReason !== "" && (
              <span className={styles.danger}>（{entry.blockedReason}）</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

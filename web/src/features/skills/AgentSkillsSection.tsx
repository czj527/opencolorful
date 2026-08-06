import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isSkillServiceUnavailable, SkillApiClient } from "../../lib/skill-api.js";
import type { AgentSkillsViewData, SkillConfirmationView } from "../../lib/skill-types.js";
import { LEARNING_POLICY_LABELS, SELECTION_OPTIONS, shortHash } from "./skill-format.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Agent 编辑页 Skill 绑定（plans/phase-13.md §14.4）
//
// - 绑定列表（visible/shadowed/disabled/gated）＋模式覆盖
//   （implicit / explicit-only / disabled）＋学习策略；
// - disabled（持久停用）与解绑需要用户确认：Server 返回
//   confirmation_required + 一次性令牌 → 内联确认卡 → approve 端点
//   → 带令牌重试（复用 T6 confirmation token 流）；
// - 学习策略变更走 UI 内确认流程（§14.4 允许），confirmed=true 提交。
// ═══════════════════════════════════════════════════════════════

export interface AgentSkillsSectionProps {
  readonly agentId: string;
  readonly skillApi: SkillApiClient;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

interface PendingConfirmation {
  readonly action: "unbind" | "set-selection-disabled";
  readonly skillRefKey: string;
  readonly confirmation: SkillConfirmationView;
}

export function AgentSkillsSection(props: AgentSkillsSectionProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [view, setView] = useState<AgentSkillsViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const result = await props.skillApi.listAgentSkills(props.agentId);
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
  }, [props.skillApi, props.agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeSelection = useCallback(async (skillRefKey: string, selection: "implicit" | "explicit-only" | "disabled") => {
    setBusy(true);
    setError(null);
    setNote(null);
    setPending(null);
    try {
      const result = await props.skillApi.updateAgentSkills(props.agentId, {
        action: "set-selection",
        skillRefKey,
        selection,
      });
      if (result.status === "confirmation_required" && result.confirmation !== undefined) {
        setPending({ action: "set-selection-disabled", skillRefKey, confirmation: result.confirmation });
        return;
      }
      if (result.status !== "ok") {
        setError(result.reason ?? "选择模式变更失败");
        return;
      }
      setNote(`选择模式已保存（${skillRefKey} → ${selection}），下一 turn 生效。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择模式变更失败");
    } finally {
      setBusy(false);
    }
  }, [props.skillApi, props.agentId, load]);

  const unbind = useCallback(async (skillRefKey: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    setPending(null);
    try {
      const result = await props.skillApi.updateAgentSkills(props.agentId, {
        action: "unbind",
        skillRefKey,
      });
      if (result.status === "confirmation_required" && result.confirmation !== undefined) {
        setPending({ action: "unbind", skillRefKey, confirmation: result.confirmation });
        return;
      }
      if (result.status !== "ok") {
        setError(result.reason ?? "解绑失败");
        return;
      }
      setNote(`已解绑 ${skillRefKey}，下一 turn 生效。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "解绑失败");
    } finally {
      setBusy(false);
    }
  }, [props.skillApi, props.agentId, load]);

  const confirmPending = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await props.skillApi.approveConfirmation(pending.confirmation.token, { agentId: props.agentId });
    } catch (cause) {
      setError(cause instanceof Error ? `确认失败：${cause.message}` : "确认失败");
      setBusy(false);
      return;
    }
    try {
      if (pending.action === "unbind") {
        const result = await props.skillApi.updateAgentSkills(props.agentId, {
          action: "unbind",
          skillRefKey: pending.skillRefKey,
          confirmationToken: pending.confirmation.token,
        });
        if (result.status !== "ok") {
          setError(result.reason ?? "解绑失败");
          return;
        }
        setNote(`已解绑 ${pending.skillRefKey}（用户确认），下一 turn 生效。`);
      } else {
        const result = await props.skillApi.updateAgentSkills(props.agentId, {
          action: "set-selection",
          skillRefKey: pending.skillRefKey,
          selection: "disabled",
          confirmationToken: pending.confirmation.token,
        });
        if (result.status !== "ok") {
          setError(result.reason ?? "停用失败");
          return;
        }
        setNote(`已停用 ${pending.skillRefKey}（用户确认），下一 turn 生效。`);
      }
      setPending(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [pending, props.skillApi, props.agentId, load]);

  const changePolicy = useCallback(async (policy: "disabled" | "ask-always" | "ask-on-risk") => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await props.skillApi.setLearningPolicy(props.agentId, policy);
      if (result.status === "confirmation_required") {
        setNote(`学习策略变更需要确认（${result.reason ?? "请再次提交确认"}）`);
        return;
      }
      setNote(`学习策略已更新为 ${policy}。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? `学习策略保存失败：${cause.message}` : "学习策略保存失败");
    } finally {
      setBusy(false);
    }
  }, [props.skillApi, props.agentId, load]);

  return (
    <section className={styles.section ?? ""} data-testid="agent-skills-section">
      <h3 className={styles.sectionTitle ?? ""}>Skill 绑定</h3>
      <p className={styles.hint}>
        Skill 绑定、选择模式与停用/解绑从<strong>下一 turn 生效</strong>；持久停用/解绑需要你的一次性确认。
        Skill 只决定做事方法，不授予任何工具/网络/Secret 权限。
      </p>

      {loadState === "loading" && <p className={styles.hint}>加载中…</p>}
      {loadState === "unavailable" && (
        <p className={styles.hint}>Skill 服务未就绪（/api/agents/:id/skills 未接线）。Agent 身份与底色编辑不受影响。</p>
      )}
      {loadState === "error" && <div className={styles.errorBlock}>{error}</div>}
      {error !== null && <div className={styles.errorBlock}>{error}</div>}
      {note !== null && <p className={styles.note} role="status">{note}</p>}

      {loadState === "ready" && view !== null && (
        <>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>学习策略</span>
              <span className={styles.muted}>{LEARNING_POLICY_LABELS[view.learningPolicy] ?? view.learningPolicy}</span>
            </div>
            <div className={styles.actions}>
              {(["disabled", "ask-always", "ask-on-risk"] as const).map((policy) => (
                <Button
                  key={policy}
                  size="sm"
                  variant={view.learningPolicy === policy ? "primary" : "ghost"}
                  onClick={() => void changePolicy(policy)}
                  disabled={busy}
                  data-testid={`policy-${policy}`}
                >
                  {policy}
                </Button>
              ))}
            </div>
            <p className={styles.hint}>学习策略只影响 Agent 主动安装；本页面的手工安装不受影响。</p>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <Boxes size={14} aria-hidden="true" />
              <span className={styles.cardTitle}>绑定列表（可见 {view.visible.length} / shadowed {view.shadowed.length} / disabled {view.disabled.length} / gated {view.gated.length}）</span>
            </div>
            {view.visible.length === 0 && view.shadowed.length === 0 && view.disabled.length === 0 && (
              <p className={styles.hint}>该 Agent 尚未绑定 Skill（先在 /skills 安装，或让 Agent 搜索后绑定）。</p>
            )}
            <ul className={styles.list}>
              {[...view.visible, ...view.disabled, ...view.shadowed].map((entry) => (
                <li key={entry.skillRefKey} className={styles.card}>
                  <div className={styles.row}>
                    <span className={styles.cardTitle}>{entry.displayName}</span>
                    <StatusPill tone={entry.selection === "disabled" ? "muted" : "ok"}>
                      {entry.selection ?? "implicit"}
                    </StatusPill>
                    <span className={styles.muted}>v{entry.version}</span>
                    <span className={styles.code}>{shortHash(entry.skillRefKey)}</span>
                  </div>
                  <div className={styles.actions}>
                    <select
                      value={entry.selection ?? "implicit"}
                      onChange={(event) => void changeSelection(entry.skillRefKey, event.target.value as "implicit" | "explicit-only" | "disabled")}
                      aria-label={`${entry.displayName} 选择模式`}
                      disabled={busy}
                      className={styles.select ?? undefined}
                      data-testid={`selection-${entry.skillId}`}
                    >
                      {SELECTION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void unbind(entry.skillRefKey)}
                      data-testid={`unbind-${entry.skillId}`}
                    >
                      解绑（需确认）
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {view.gated.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardTitle}>gated（readiness 阻断，保留绑定与证据）</span>
              </div>
              {view.gated.map((entry) => (
                <p className={styles.danger} key={entry.skillRefKey}>
                  {entry.displayName}：{entry.blockedReason ?? "无原因"}
                </p>
              ))}
            </div>
          )}

          {pending !== null && (
            <div className={styles.approvalCard} data-testid="agent-skill-confirmation">
              <div className={styles.approvalTitle}>需要你的一次性确认</div>
              <p className={styles.approvalItem}>
                {pending.action === "unbind" ? "解绑" : "停用（disabled）"}：
                {pending.skillRefKey}
              </p>
              <p className={styles.approvalItem}>原因：{pending.confirmation.reason}</p>
              <p className={styles.approvalItem}>令牌过期：{pending.confirmation.expiresAt}</p>
              <div className={styles.actions}>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirmPending()} data-testid="agent-skill-confirm">
                  确认
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                  取消
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

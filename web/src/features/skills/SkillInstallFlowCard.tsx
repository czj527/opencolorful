import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button, Spinner } from "../../components/ui/index.js";
import { SkillApiClient, SkillApiError } from "../../lib/skill-api.js";
import type { SkillInspectResult, SkillInstallResult } from "../../lib/skill-types.js";
import { shortHash } from "./skill-format.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 会话内安装流程卡（plans/phase-13.md §11.3 / §14.4）
//
// 完整安装流程的**可追踪会话内审批卡**（不使用普通弹窗承载）：
//   检查（inspect：来源/版本/哈希/风险）→ 安装（可能 confirmation_required）
//   → 一次性确认卡（来源+版本+哈希+风险原因，经
//   /api/skills/confirmation/:tokenId/approve）→ 带令牌重试安装
//   → 结果（skillRef/operationId/agentBinding/activationGrant/loadHandle）。
//
// 状态机：idle → inspecting → review(confirmation_required) →
// approving → installing → done | error。
// ═══════════════════════════════════════════════════════════════

export interface SkillInstallFlowCardProps {
  readonly skillApi: SkillApiClient;
  readonly sourceRef: string;
  readonly kind: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  /** 挂载即开始检查（聊天/详情内嵌场景）；缺省时显示「开始安装」按钮 */
  readonly autoStart?: boolean;
  readonly onSettled?: (result: SkillInstallResult | null) => void;
}

export type InstallFlowState =
  | { readonly phase: "idle" }
  | { readonly phase: "inspecting" }
  | { readonly phase: "review"; readonly inspection: SkillInspectResult; readonly confirmation: NonNullable<SkillInstallResult["confirmation"]>; readonly risks: readonly { readonly code: string; readonly message: string; readonly path?: string }[] }
  | { readonly phase: "approving" }
  | { readonly phase: "installing" }
  | { readonly phase: "done"; readonly result: SkillInstallResult }
  | { readonly phase: "error"; readonly reason: string; readonly reasonCode?: string };

export function SkillInstallFlowCard(props: SkillInstallFlowCardProps) {
  const [state, setState] = useState<InstallFlowState>({ phase: "idle" });
  const reviewRef = useRef<Extract<InstallFlowState, { readonly phase: "review" }> | null>(null);
  const settledRef = useRef(props.onSettled);
  settledRef.current = props.onSettled;

  const transition = useCallback((next: InstallFlowState) => {
    if (next.phase === "review") {
      reviewRef.current = next;
    }
    setState(next);
  }, []);

  const start = useCallback(() => {
    void runFlow(props, transition);
  }, [props.sourceRef, props.kind, props.agentId, props.sessionId, transition]);

  // autoStart：挂载即开始检查（聊天/详情内嵌场景；以 ref 防 StrictMode 双启动）
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (props.autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      start();
    }
  }, [props.autoStart, start]);

  if (!props.autoStart && state.phase === "idle") {
    return (
      <div className={styles.card} data-testid="skill-install-card">
        <div className={styles.row}>
          <span className={styles.cardMeta}>
            安装 {props.sourceRef}（kind={props.kind}）
          </span>
          <Button size="sm" onClick={start} data-testid="skill-install-start">
            开始安装
          </Button>
        </div>
      </div>
    );
  }

  const settle = (result: SkillInstallResult | null) => {
    settledRef.current?.(result);
  };

  switch (state.phase) {
    case "idle":
    case "inspecting":
    case "installing":
      return (
        <div className={styles.card} data-testid="skill-install-card">
          <div className={styles.row}>
            {state.phase === "installing" ? (
              <Spinner size={14} />
            ) : (
              <Loader2 size={14} className="spinner-icon" aria-label="检查中" />
            )}
            <span className={styles.cardMeta}>
              {state.phase === "idle" && "正在准备…"}
              {state.phase === "inspecting" && `正在检查 ${props.sourceRef}（来源/版本/哈希/风险）…`}
              {state.phase === "installing" && "正在安装（不可变 Artifact + 绑定）…"}
            </span>
          </div>
        </div>
      );
    case "review": {
      const { inspection, confirmation, risks } = state;
      return (
        <div className={styles.approvalCard} data-testid="skill-approval-card">
          <div className={styles.approvalTitle}>
            <AlertTriangle size={13} aria-hidden="true" /> 安装需要你的一次性确认
          </div>
          <p className={styles.approvalItem}>来源：{props.sourceRef}（kind={props.kind}）</p>
          <p className={styles.approvalItem}>
            版本：{inspection.version ?? "—"}；内容哈希：{shortHash(inspection.contentHash)}
          </p>
          <p className={styles.approvalItem}>名称：{inspection.manifest?.name ?? inspection.skillId ?? "—"}</p>
          {inspection.manifest?.license !== undefined && (
            <p className={styles.approvalItem}>许可证：{inspection.manifest.license}</p>
          )}
          {inspection.manifest?.requires !== undefined && (
            <p className={styles.approvalItem}>
              依赖声明：{JSON.stringify(inspection.manifest.requires)}
            </p>
          )}
          {risks.length > 0 && (
            <div>
              <p className={styles.approvalItem}>风险标记：</p>
              {risks.map((risk, index) => (
                <p className={styles.approvalItem} key={`${risk.code}-${index}`}>
                  - [{risk.code}] {risk.message}
                </p>
              ))}
            </div>
          )}
          <p className={styles.approvalItem}>确认原因：{confirmation.reason}</p>
          <p className={styles.approvalItem}>令牌过期：{confirmation.expiresAt}</p>
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="primary"
              data-testid="skill-approve"
              onClick={() => void approve(props, transition, reviewRef, settle)}
            >
              确认并安装
            </Button>
            <Button size="sm" variant="ghost" onClick={() => transition({ phase: "idle" })}>
              取消
            </Button>
          </div>
        </div>
      );
    }
    case "approving":
      return (
        <div className={styles.card} data-testid="skill-install-card">
          <div className={styles.row}>
            <Spinner size={14} />
            <span className={styles.cardMeta}>正在确认安装请求…</span>
          </div>
        </div>
      );
    case "done":
      return (
        <div className={styles.card} data-testid="skill-install-result">
          <div className={styles.row}>
            <CheckCircle2 size={14} color="var(--success)" aria-label="已完成" />
            <span className={styles.cardTitle}>安装完成</span>
          </div>
          <p className={styles.approvalItem}>skillRef：{JSON.stringify(state.result.skillRef ?? null)}</p>
          {state.result.operationId !== undefined && (
            <p className={styles.approvalItem}>operationId：{state.result.operationId}</p>
          )}
          <p className={styles.approvalItem}>
            agentBinding：{state.result.agentBinding ?? "unchanged"}；activationGrant：
            {state.result.activationGrant ?? "unavailable"}
          </p>
          {state.result.activationGrant === "granted" && (
            <p className={styles.approvalItem}>
              当前 turn 激活：已授权（grantId={state.result.grantId ?? "?"}）；
              loadHandle={state.result.loadHandle === null ? "null" : state.result.loadHandle}
            </p>
          )}
        </div>
      );
    case "error":
      return (
        <div className={styles.errorBlock} data-testid="skill-install-error">
          <div className={styles.row}>
            <XCircle size={14} aria-hidden="true" />
            <span>安装失败：{state.reason}</span>
          </div>
          {state.reasonCode !== undefined && <p className={styles.muted}>reasonCode：{state.reasonCode}</p>}
        </div>
      );
  }
}

async function runFlow(props: SkillInstallFlowCardProps, transition: (next: InstallFlowState) => void): Promise<void> {
  transition({ phase: "inspecting" });
  const settled = props.onSettled;
  try {
    const inspection = await props.skillApi.inspectSkill({
      sourceRef: props.sourceRef,
      kind: props.kind,
      ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
    });
    if (!inspection.ok) {
      transition({
        phase: "error",
        reason: inspection.reason ?? "来源检查失败",
        ...(inspection.reasonCode !== undefined ? { reasonCode: inspection.reasonCode } : {}),
      });
      settled?.(null);
      return;
    }
    const first = await props.skillApi.installSkill({
      sourceRef: props.sourceRef,
      kind: props.kind,
      ...(props.agentId !== undefined ? { agentId: props.agentId } : {}),
      ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
    });
    if (first.status === "confirmation_required" && first.confirmation !== undefined) {
      transition({
        phase: "review",
        inspection,
        confirmation: first.confirmation,
        risks: first.risks ?? [],
      });
      return;
    }
    settleFlow(first, transition, settled);
  } catch (cause) {
    transition({
      phase: "error",
      reason: cause instanceof Error ? cause.message : "安装流程失败",
      ...(cause instanceof SkillApiError && cause.reasonCode !== undefined ? { reasonCode: cause.reasonCode } : {}),
    });
    settled?.(null);
  }
}

async function approve(
  props: SkillInstallFlowCardProps,
  transition: (next: InstallFlowState) => void,
  reviewRef: React.MutableRefObject<Extract<InstallFlowState, { readonly phase: "review" }> | null>,
  settle: (result: SkillInstallResult | null) => void,
): Promise<void> {
  const current = reviewRef.current;
  if (current === null) {
    transition({ phase: "error", reason: "确认上下文丢失，请重新发起安装" });
    settle(null);
    return;
  }
  transition({ phase: "approving" });
  try {
    await props.skillApi.approveConfirmation(current.confirmation.token, {
      ...(props.agentId !== undefined ? { agentId: props.agentId } : {}),
      ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
    });
  } catch (cause) {
    transition({
      phase: "error",
      reason: cause instanceof Error ? `确认失败：${cause.message}` : "确认失败",
      ...(cause instanceof SkillApiError && cause.reasonCode !== undefined ? { reasonCode: cause.reasonCode } : {}),
    });
    settle(null);
    return;
  }
  transition({ phase: "installing" });
  try {
    const result = await props.skillApi.installSkill({
      sourceRef: props.sourceRef,
      kind: props.kind,
      ...(props.agentId !== undefined ? { agentId: props.agentId } : {}),
      ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
      confirmationToken: current.confirmation.token,
    });
    settleFlow(result, transition, settle);
  } catch (cause) {
    transition({
      phase: "error",
      reason: cause instanceof Error ? `安装失败：${cause.message}` : "安装失败",
      ...(cause instanceof SkillApiError && cause.reasonCode !== undefined ? { reasonCode: cause.reasonCode } : {}),
    });
    settle(null);
  }
}

function settleFlow(
  result: SkillInstallResult,
  transition: (next: InstallFlowState) => void,
  settled: ((result: SkillInstallResult | null) => void) | undefined,
): void {
  switch (result.status) {
    case "installed":
      transition({ phase: "done", result });
      break;
    case "rejected":
      transition({
        phase: "error",
        reason: result.reason ?? "安装被拒绝",
        ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
      });
      break;
    case "failed":
      transition({
        phase: "error",
        reason: result.reason ?? "安装失败",
        ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
      });
      break;
    case "confirmation_required":
      transition({ phase: "idle" });
      break;
  }
  settled?.(result);
}

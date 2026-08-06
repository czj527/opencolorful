import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldQuestion } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { SkillApiClient } from "../../lib/skill-api.js";
import type { SkillConfirmationView, SkillInstallResult } from "../../lib/skill-types.js";
import { shortHash } from "./skill-format.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 聊天页安装状态卡（plans/phase-13.md §13.3 / §14.4）
//
// 渲染主会话中 install_skill 工具调用（ToolCallItem 内嵌）：
// - 运行中：安装检查/审批/安装进度（来自工具 result/delta 的结构化状态）；
// - confirmation_required：一次性确认卡（来源+版本+哈希+风险原因），
//   经 /api/skills/confirmation/:tokenId/approve 确认（可追踪，非普通弹窗）；
// - installed：显示 skillRef / operationId / agentBinding / activationGrant /
//   loadHandle（当前 turn 激活状态）。
//
// 本卡只展示与确认；安装动作本身始终由 Agent 的 install_skill 工具执行
// （审批成功后由用户提示 Agent 携带 confirmationToken 重试）。
// ═══════════════════════════════════════════════════════════════

export interface SkillInstallToolCardProps {
  /** 缺省时使用同源 API（聊天主会话默认场景） */
  readonly skillApi?: SkillApiClient;
  readonly toolName: string;
  readonly status: "running" | "completed" | "error";
  readonly result?: unknown;
  readonly delta?: string;
}

/** 聊天工具卡默认同源 API 客户端（与 App 层 ApiClient 同一 base）。 */
const DEFAULT_SKILL_API = new SkillApiClient("");

interface InstallResultLike {
  readonly status?: string;
  readonly skillRef?: { readonly skillId?: string; readonly sourceId?: string; readonly version?: string; readonly contentHash?: string } | null;
  readonly operationId?: string;
  readonly agentBinding?: string;
  readonly activationGrant?: string;
  readonly loadHandle?: string | null;
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly confirmation?: SkillConfirmationView;
  readonly risks?: readonly { readonly code?: string; readonly message?: string }[];
}

function parseResult(result: unknown): InstallResultLike | null {
  if (result === undefined || result === null) return null;
  if (typeof result !== "object") return null;
  return result as InstallResultLike;
}

export function SkillInstallToolCard(props: SkillInstallToolCardProps) {
  const parsed = parseResult(props.result);
  const [approved, setApproved] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  // 每次新的 confirmation_required 结果到达时重置确认态
  useEffect(() => {
    if (parsed?.status === "confirmation_required" && parsed.confirmation !== undefined) {
      tokenRef.current = parsed.confirmation.token;
      setApproved(false);
      setApproveError(null);
    }
  }, [parsed?.status, parsed?.confirmation?.token]);

  const approvingRequest = approving || (props.status === "running" && parsed?.status !== "confirmation_required");

  return (
    <div className={styles.card} data-testid="skill-install-tool-card">
      <div className={styles.cardHeader}>
        <ShieldQuestion size={14} aria-hidden="true" />
        <span className={styles.cardTitle}>{props.toolName}</span>
        {approvingRequest && <Loader2 size={12} className="spinner-icon" aria-label="运行中" />}
        {props.status === "completed" && parsed?.status === "installed" && (
          <CheckCircle2 size={12} color="var(--success)" aria-label="已安装" />
        )}
        {props.status === "error" && <AlertTriangle size={12} color="var(--danger)" aria-label="失败" />}
      </div>

      {props.status === "running" && parsed === null && props.delta !== undefined && props.delta !== "" && (
        <p className={styles.muted}>{props.delta.slice(-200)}</p>
      )}

      {parsed !== null && parsed.status === "confirmation_required" && parsed.confirmation !== undefined && (
        <ApprovalBlock
          confirmation={parsed.confirmation}
          risks={parsed.risks ?? []}
          approved={approved}
          approving={approving}
          error={approveError}
          onApprove={async () => {
            const token = tokenRef.current;
            if (token === null) return;
            setApproving(true);
            setApproveError(null);
            try {
              await (props.skillApi ?? DEFAULT_SKILL_API).approveConfirmation(token);
              setApproved(true);
            } catch (cause) {
              setApproveError(cause instanceof Error ? cause.message : "确认失败");
            } finally {
              setApproving(false);
            }
          }}
        />
      )}

      {parsed !== null && parsed.status === "installed" && (
        <div data-testid="skill-install-tool-installed">
          <p className={styles.approvalItem}>
            skillRef：{JSON.stringify(parsed.skillRef ?? null)}
          </p>
          {parsed.operationId !== undefined && (
            <p className={styles.approvalItem}>operationId：{parsed.operationId}</p>
          )}
          <p className={styles.approvalItem}>
            agentBinding：{parsed.agentBinding ?? "unchanged"}；activationGrant：
            {parsed.activationGrant ?? "unavailable"}
          </p>
          {parsed.activationGrant === "granted" && (
            <p className={styles.approvalItem}>
              当前 turn 激活：已授权；loadHandle={parsed.loadHandle === null || parsed.loadHandle === undefined ? "null" : parsed.loadHandle}
            </p>
          )}
        </div>
      )}

      {props.status === "error" && (
        <p className={styles.muted}>
          {parsed?.reason ?? "工具失败"}{parsed?.reasonCode !== undefined ? `（${parsed.reasonCode}）` : ""}
        </p>
      )}

      {props.status === "completed" && parsed !== null && parsed.status === "rejected" && (
        <p className={styles.muted}>被拒绝：{parsed.reason ?? "未知原因"}</p>
      )}
    </div>
  );
}

function ApprovalBlock(props: {
  readonly confirmation: SkillConfirmationView;
  readonly risks: readonly { readonly code?: string; readonly message?: string }[];
  readonly approved: boolean;
  readonly approving: boolean;
  readonly error: string | null;
  readonly onApprove: () => void;
}) {
  if (props.approved) {
    return (
      <div className={styles.note} role="status" data-testid="skill-tool-approved">
        已确认（一次性令牌 {shortHash(props.confirmation.token)}）。请让 Agent 携带该令牌继续安装。
      </div>
    );
  }
  return (
    <div className={styles.approvalCard} data-testid="skill-tool-approval-card">
      <div className={styles.approvalTitle}>
        <AlertTriangle size={13} aria-hidden="true" /> 安装需要你的一次性确认
      </div>
      <p className={styles.approvalItem}>原因：{props.confirmation.reason}</p>
      {props.confirmation.riskLevel !== undefined && (
        <p className={styles.approvalItem}>风险等级：{props.confirmation.riskLevel}</p>
      )}
      {props.risks.map((risk, index) => (
        <p className={styles.approvalItem} key={`risk-${index}`}>
          - [{risk.code ?? "?"}] {risk.message ?? ""}
        </p>
      ))}
      <p className={styles.approvalItem}>令牌过期：{props.confirmation.expiresAt}</p>
      {props.error !== null && <p className={styles.danger}>{props.error}</p>}
      <div className={styles.actions}>
        <Button size="sm" variant="primary" disabled={props.approving} onClick={props.onApprove} data-testid="skill-tool-approve">
          {props.approving ? "确认中…" : "确认安装"}
        </Button>
      </div>
    </div>
  );
}

/** 便捷：判断工具结果是否为 install_skill 的确认卡场景。 */
export function isSkillInstallCardResult(result: unknown): boolean {
  const parsed = parseResult(result);
  return parsed !== null && (parsed.status === "confirmation_required" || parsed.status === "installed" || parsed.status === "rejected");
}

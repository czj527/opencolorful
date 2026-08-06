import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ListTree, ShieldCheck } from "lucide-react";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { SafeSkillView, SkillFileTree, SkillInspectResult } from "../../lib/skill-types.js";
import { formatBytes, readinessTone, shortHash, statusText } from "./skill-format.js";
import { LoadingBlock, SkillServiceUnavailable, StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill 详情（plans/phase-13.md §14.4）
// 正文摘要（受控读取）/ 文件树 / 来源证明 / 兼容性 / 依赖 / 事件入口。
// ═══════════════════════════════════════════════════════════════

export interface SkillDetailViewProps {
  readonly skillApi: SkillApiClient;
  readonly skillRefKey: string;
  readonly onBack: () => void;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function SkillDetailView(props: SkillDetailViewProps) {
  const [detail, setDetail] = useState<SafeSkillView | null>(null);
  const [files, setFiles] = useState<SkillFileTree | null>(null);
  const [inspection, setInspection] = useState<SkillInspectResult | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyNote, setBodyNote] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const sessionId = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("session") ?? undefined
    : undefined;

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const view = await props.skillApi.getSkillDetail(props.skillRefKey);
      setDetail(view);
      const [treeResult, inspectResult, bodyResult] = await Promise.all([
        props.skillApi.getSkillFiles(props.skillRefKey).catch(() => null),
        props.skillApi
          .inspectSkill({ skillRef: view.skillRef, ...(sessionId !== undefined ? { sessionId } : {}) })
          .catch(() => null),
        props.skillApi.getSkillDetailWithBody(props.skillRefKey, sessionId).catch(() => null),
      ]);
      setFiles(treeResult);
      setInspection(inspectResult);
      if (bodyResult !== null) {
        if (bodyResult.body !== undefined) {
          setBody(bodyResult.body);
          setBodyNote(bodyResult.truncated === true ? "（正文超过读取预算，已截断）" : null);
        } else if (bodyResult.bodyUnavailable !== undefined) {
          setBodyNote(bodyResult.bodyUnavailable);
        }
      } else {
        setBodyNote("正文读取不可用（Skill 服务未就绪或未在会话上下文内）");
      }
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "详情加载失败");
    }
  }, [props.skillApi, props.skillRefKey, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === "loading") return <LoadingBlock />;
  if (loadState === "unavailable") return <SkillServiceUnavailable />;
  if (loadState === "error" || detail === null) {
    return <div className={styles.errorBlock}>{error ?? "详情加载失败"}</div>;
  }

  const manifest = inspection?.manifest;
  const requires = manifest?.requires;
  const recommends = manifest?.recommends;
  const blocked = detail.status.readiness === "blocked" || detail.status.readiness === "incompatible";

  return (
    <div>
      <div className={styles.row}>
        <button type="button" className={styles.back} onClick={props.onBack} data-testid="skill-detail-back">
          <ArrowLeft size={13} aria-hidden="true" /> 返回
        </button>
        <h2 className={styles.cardTitle}>{detail.displayName}</h2>
        <StatusPill tone={readinessTone(detail.status.readiness)}>{detail.status.readiness}</StatusPill>
        <StatusPill tone={blocked ? "danger" : "muted"}>{detail.status.selection}</StatusPill>
        <span className={styles.muted}>v{detail.version}</span>
      </div>
      {detail.description !== undefined && <p className={styles.hint}>{detail.description}</p>}

      <table className={styles.table} aria-label="Skill 元数据">
        <tbody>
          <tr>
            <th>状态四元组</th>
            <td>
              {statusText(detail.status)}
              {detail.status.blockedReason !== undefined && (
                <span className={styles.danger}>（{detail.status.blockedReason}）</span>
              )}
            </td>
          </tr>
          <tr>
            <th>来源</th>
            <td>{detail.sourceKind} · <span className={styles.code}>{detail.sourceId}</span></td>
          </tr>
          <tr>
            <th>版本 / 哈希</th>
            <td className={styles.code}>{detail.version} · {shortHash(detail.contentHash)}</td>
          </tr>
          <tr>
            <th>大小 / 文件数</th>
            <td>{formatBytes(detail.sizeBytes)} / {detail.fileCount}</td>
          </tr>
          <tr>
            <th>兼容性</th>
            <td>
              {detail.compatibility === null ? "—" : detail.compatibility.level}
              {detail.compatibility !== null && detail.compatibility.requiresManualMigration && (
                <span className={styles.warn}>（需手工迁移）</span>
              )}
            </td>
          </tr>
          <tr>
            <th>来源证明</th>
            <td>
              {detail.provenance === null ? "（无）" : (
                <span className={styles.code}>
                  sourceRef={detail.provenance.sourceRef}；fetchedAt={detail.provenance.fetchedAt}
                  {detail.provenance.license !== undefined && `；license=${detail.provenance.license}`}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {requires !== undefined && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <ShieldCheck size={14} aria-hidden="true" />
            <span className={styles.cardTitle}>依赖声明（requires，只诊断不授权）</span>
          </div>
          <p className={styles.muted}>{JSON.stringify(requires)}</p>
        </div>
      )}
      {recommends !== undefined && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>推荐依赖（recommends）</span>
          </div>
          <p className={styles.muted}>{JSON.stringify(recommends)}</p>
        </div>
      )}
      {inspection?.risks !== undefined && inspection.risks.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>风险标记</span>
          </div>
          {inspection.risks.map((risk, index) => (
            <p className={styles.muted} key={`risk-${index}`}>- [{risk.code}] {risk.message}</p>
          ))}
        </div>
      )}

      <h3 className={styles.sectionTitle}>正文摘要</h3>
      {body !== null ? (
        <pre className={styles.body ?? ""} data-testid="skill-body-summary">
          {body}
          {bodyNote !== null && `\n${bodyNote}`}
        </pre>
      ) : (
        <p className={styles.hint}>{bodyNote ?? "正文不可用。"}（正文经受控读取；在会话内查看可传 ?session=&lt;id&gt;）</p>
      )}

      <h3 className={styles.sectionTitle}>
        <ListTree size={13} aria-hidden="true" /> 文件树
      </h3>
      {files === null ? (
        <p className={styles.hint}>文件树不可用。</p>
      ) : (
        <ul className={styles.list} data-testid="skill-file-tree">
          {files.files.map((file) => (
            <li key={file.rel} className={styles.bundleRow}>
              <span className={styles.code}>{file.rel}</span>
              <span className={styles.muted}>{formatBytes(file.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        <a
          className={styles.link}
          href={`/logs?skill=${encodeURIComponent(detail.skillRefKey)}`}
          data-testid="skill-events-link"
        >
          查看相关事件（/logs?skill=…）
        </a>
      </div>
    </div>
  );
}

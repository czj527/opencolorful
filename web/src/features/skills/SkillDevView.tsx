import { useCallback, useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { LinkedSourceStatusView } from "../../lib/skill-types.js";
import { shortHash } from "./skill-format.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 开发态（plans/phase-13.md §14.1 / §15.1）
// Linked Source 只读展示：`skills link` 登记后的源码状态。
// 登记/注销仅 CLI 提供；Web 不提供写入。
// ═══════════════════════════════════════════════════════════════

export interface SkillDevViewProps {
  readonly skillApi: SkillApiClient;
}

export function SkillDevView(props: SkillDevViewProps) {
  const [linked, setLinked] = useState<readonly LinkedSourceStatusView[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const list = await props.skillApi.listLinkedSources();
      setLinked(list);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [props.skillApi]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === "loading") return <p className={styles.hint}>加载中…</p>;
  if (loadState === "unavailable") {
    return <p className={styles.hint}>Skill 服务未就绪（/api/skills/linked-sources 未接线）。</p>;
  }
  if (loadState === "error") {
    return <div className={styles.errorBlock}>Linked Source 加载失败：{error}</div>;
  }

  return (
    <div>
      <p className={styles.hint}>
        Linked Source 是 <code>skills link</code> 登记的<strong>只读引用</strong>（不复制到 Managed
        Store）。修改源码后下一 turn 重新哈希生效；此处状态为每次读取时的实时校验结果。
      </p>
      {linked.length === 0 && (
        <p className={styles.empty}>
          没有 Linked Source。在终端运行 <code>skills link &lt;path&gt;</code> 登记源码目录。
        </p>
      )}
      <ul className={styles.list}>
        {linked.map((entry) => (
          <li key={entry.sourceId} className={styles.card} data-testid={`linked-${entry.sourceId}`}>
            <div className={styles.cardHeader}>
              <GitBranch size={14} aria-hidden="true" />
              <span className={styles.cardTitle}>{entry.sourceId}</span>
              <StatusPill tone={entry.valid ? "ok" : "danger"}>
                {entry.valid ? "有效" : "无效"}
              </StatusPill>
              <span className={styles.muted}>{entry.skillName ?? "—"} v{entry.version ?? "?"}</span>
            </div>
            <p className={styles.muted}>
              路径：<span className={styles.code}>{entry.rootPath}</span>
            </p>
            <p className={styles.muted}>
              内容哈希：{shortHash(entry.contentHash)}；大小：{entry.sizeBytes} B / {entry.fileCount} 文件；
              登记时间：{entry.linkedAt}
            </p>
            {entry.errors.map((message, index) => (
              <p className={styles.danger} key={`err-${index}`}>错误：{message}</p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

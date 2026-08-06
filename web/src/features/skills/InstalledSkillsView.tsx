import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { SafeSkillView } from "../../lib/skill-types.js";
import { readinessTone, shortHash, statusText } from "./skill-format.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 已安装列表（plans/phase-13.md §14.4）
// 来源 / 版本 / 哈希 / 风险 / 依赖 / 兼容性 / 状态四元组。
// ═══════════════════════════════════════════════════════════════

export interface InstalledSkillsViewProps {
  readonly skillApi: SkillApiClient;
  readonly onOpenDetail: (skillRefKey: string) => void;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function InstalledSkillsView(props: InstalledSkillsViewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [skills, setSkills] = useState<readonly SafeSkillView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const list = await props.skillApi.listSkills();
      setSkills(list);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [props.skillApi]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === "loading") {
    return <p className={styles.hint}>加载中…</p>;
  }
  if (loadState === "unavailable") {
    return <p className={styles.hint}>Skill 服务未就绪（/api/skills 未接线或 Server 未启动）。</p>;
  }
  if (loadState === "error") {
    return <div className={styles.errorBlock}>已安装列表加载失败：{error}</div>;
  }

  if (skills.length === 0) {
    return <p className={styles.empty}>Catalog 为空：还没有已安装/可见的 Skill。</p>;
  }

  return (
    <div>
      <p className={styles.hint}>共 {skills.length} 项。状态四元组：有效性 / 信任 / readiness / 选择模式。</p>
      <ul className={styles.list}>
        {skills.map((skill) => {
          const blocked = skill.status.readiness === "blocked" || skill.status.readiness === "incompatible";
          return (
            <li key={skill.skillRefKey} className={styles.card} data-testid={`skill-row-${skill.skillId}`}>
              <div className={styles.cardHeader}>
                <Boxes size={15} aria-hidden="true" />
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => props.onOpenDetail(skill.skillRefKey)}
                  data-testid={`skill-open-${skill.skillId}`}
                >
                  {skill.displayName}
                </button>
                <StatusPill tone={readinessTone(skill.status.readiness)}>
                  {skill.status.readiness}
                </StatusPill>
                <StatusPill tone={blocked ? "danger" : "muted"}>
                  {skill.status.selection}
                </StatusPill>
                <span className={styles.muted}>v{skill.version}</span>
              </div>
              {skill.description !== undefined && (
                <p className={styles.muted}>{skill.description}</p>
              )}
              <table className={styles.table} aria-label={`${skill.displayName} 元数据`}>
                <tbody>
                  <tr>
                    <th>来源</th>
                    <td>
                      {skill.sourceKind} · <span className={styles.code}>{skill.sourceId}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>内容哈希</th>
                    <td className={styles.code}>{shortHash(skill.contentHash)}</td>
                  </tr>
                  <tr>
                    <th>状态</th>
                    <td>
                      {statusText(skill.status)}
                      {skill.status.blockedReason !== undefined && (
                        <span className={styles.danger}>（{skill.status.blockedReason}）</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>大小 / 文件</th>
                    <td>{skill.sizeBytes} B / {skill.fileCount} 文件</td>
                  </tr>
                  <tr>
                    <th>兼容性</th>
                    <td>
                      {skill.compatibility === null
                        ? "—"
                        : `${skill.compatibility.level}${skill.compatibility.requiresManualMigration ? "（需手工迁移）" : ""}`}
                    </td>
                  </tr>
                  <tr>
                    <th>风险</th>
                    <td>{skill.validityErrors.length === 0 ? "无结构错误" : `${skill.validityErrors.length} 个校验错误`}</td>
                  </tr>
                </tbody>
              </table>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

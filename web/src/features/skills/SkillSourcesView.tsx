import { useCallback, useEffect, useState } from "react";
import { FolderOpen, ShieldCheck } from "lucide-react";
import { Toggle } from "../../components/ui/index.js";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { SourceConfigView } from "../../lib/skill-types.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 来源与信任配置（plans/phase-13.md §8.1）
// 兼容目录默认关闭；只有用户显式信任根目录后才扫描。
// ═══════════════════════════════════════════════════════════════

export interface SkillSourcesViewProps {
  readonly skillApi: SkillApiClient;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function SkillSourcesView(props: SkillSourcesViewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [view, setView] = useState<SourceConfigView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const loaded = await props.skillApi.getSourceConfig();
      setView(loaded);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [props.skillApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleTrust = useCallback(async (root: string, trusted: boolean) => {
    if (view === null) return;
    setSaving(true);
    setError(null);
    setNote(null);
    const nextRoots = trusted
      ? [...view.config.trustedRoots, root]
      : view.config.trustedRoots.filter((candidate) => candidate !== root);
    try {
      const updated = await props.skillApi.updateSourceConfig({ trustedRoots: nextRoots });
      setView(updated);
      setNote(trusted ? `已信任 ${root}（扫描从下一 turn 生效）` : `已取消信任 ${root}`);
    } catch (cause) {
      setError(cause instanceof Error ? `信任配置保存失败：${cause.message}` : "信任配置保存失败");
    } finally {
      setSaving(false);
    }
  }, [view, props.skillApi]);

  if (loadState === "loading") return <p className={styles.hint}>加载中…</p>;
  if (loadState === "unavailable") {
    return <p className={styles.hint}>Skill 服务未就绪（/api/skill-sources 未接线）。</p>;
  }
  if (loadState === "error" || view === null) {
    return <div className={styles.errorBlock}>来源配置加载失败：{error}</div>;
  }

  const disabledWorkspace = view.config.disabledKinds.includes("workspace");

  return (
    <div>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <ShieldCheck size={15} aria-hidden="true" />
          <span className={styles.cardTitle}>workspace 来源开关</span>
        </div>
        <p className={styles.hint}>
          workspace 与兼容目录默认<strong>关闭</strong>。打开后仍需信任具体根目录才会扫描；
          信任/关闭是来源设置，不由 Skill 或 Agent 自己修改。
        </p>
        <Toggle
          checked={!disabledWorkspace}
          onChange={(value) => {
            setSaving(true);
            void props.skillApi
              .updateSourceConfig({
                disabledKinds: value
                  ? view.config.disabledKinds.filter((kind) => kind !== "workspace")
                  : [...view.config.disabledKinds, "workspace"],
              })
              .then((updated) => {
                setView(updated);
                setNote(value ? "workspace 来源已开启" : "workspace 来源已关闭（默认）");
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? `保存失败：${cause.message}` : "保存失败");
              })
              .finally(() => setSaving(false));
          }}
          label="扫描 workspace 来源"
          disabled={saving}
        />
      </div>

      <h3 className={styles.sectionTitle}>
        <FolderOpen size={13} aria-hidden="true" /> 兼容目录（全部默认关闭）
      </h3>
      <p className={styles.hint}>
        .agents/.claude/.codex/.openclaw 下的 skills 目录。信任某个根目录后才扫描。
      </p>
      {view.compatibilityRoots.length === 0 && (
        <p className={styles.empty}>当前没有存在的兼容目录（目录不存在时不会列出）。</p>
      )}
      <ul className={styles.list}>
        {view.compatibilityRoots.map((root) => (
          <li key={root.root} className={styles.card} data-testid={`source-root-${root.root.replace(/[^a-z0-9]/gi, "-")}`}>
            <div className={styles.row}>
              <span className={styles.code}>{root.root}</span>
              <StatusPill tone={root.trusted ? "ok" : "muted"}>
                {root.trusted ? "已信任" : "未信任"}
              </StatusPill>
              <Toggle
                checked={root.trusted}
                onChange={(value) => void toggleTrust(root.root, value)}
                label={`信任 ${root.root}`}
                disabled={saving || disabledWorkspace}
              />
            </div>
          </li>
        ))}
      </ul>
      {error !== null && <div className={styles.errorBlock}>{error}</div>}
      {note !== null && <p className={styles.note} role="status">{note}</p>}
    </div>
  );
}

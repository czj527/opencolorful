import { useCallback, useEffect, useState } from "react";
import { Package } from "lucide-react";
import { Button, TextField } from "../../components/ui/index.js";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { BundleAdminView } from "../../lib/skill-types.js";
import { shortHash } from "./skill-format.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Bundle 列表（plans/phase-13.md §9.3 / §14.4）
// Bundle 是版本化 SkillRef 集合；变更必须创建新版本，不原地覆盖。
// ═══════════════════════════════════════════════════════════════

export interface SkillBundlesViewProps {
  readonly skillApi: SkillApiClient;
}

export function SkillBundlesView(props: SkillBundlesViewProps) {
  const [bundles, setBundles] = useState<readonly BundleAdminView[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 创建新版本表单
  const [bundleId, setBundleId] = useState("");
  const [name, setName] = useState("");
  const [skillRefKeys, setSkillRefKeys] = useState("");
  const [selection, setSelection] = useState("implicit");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const result = await props.skillApi.listBundles();
      setBundles(result.bundles);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isSkillServiceUnavailable(cause) ? "unavailable" : "error");
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [props.skillApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const createVersion = useCallback(async () => {
    const keys = skillRefKeys
      .split("\n")
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
    if (bundleId.trim() === "" || name.trim() === "" || keys.length === 0) {
      setError("需要 bundleId、name 与至少一个 --skill skillRefKey（每行一个）");
      return;
    }
    setCreating(true);
    setError(null);
    setNote(null);
    try {
      const items: { readonly skillRef: import("../../lib/skill-types.js").SkillRef; readonly selection: "implicit" | "explicit-only" | "disabled" }[] = [];
      for (const key of keys) {
        const detail = await props.skillApi.getSkillDetail(key);
        items.push({ skillRef: detail.skillRef, selection: selection as "implicit" | "explicit-only" | "disabled" });
      }
      const result = await props.skillApi.createBundleVersion({
        bundleId: bundleId.trim(),
        name: name.trim(),
        items,
      });
      if (result.status !== "ok") {
        setError(result.reason ?? "Bundle 版本化失败");
        return;
      }
      setNote(`Bundle ${bundleId.trim()} 新版本已创建（${JSON.stringify(result.result ?? {})}）`);
      setSkillRefKeys("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? `创建失败：${cause.message}` : "创建失败");
    } finally {
      setCreating(false);
    }
  }, [bundleId, name, skillRefKeys, selection, props.skillApi, load]);

  if (loadState === "loading") return <p className={styles.hint}>加载中…</p>;
  if (loadState === "unavailable") {
    return <p className={styles.hint}>Skill 服务未就绪（/api/skills/bundles 未接线）。</p>;
  }
  if (loadState === "error") {
    return <div className={styles.errorBlock}>Bundle 列表加载失败：{error}</div>;
  }

  return (
    <div>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <Package size={15} aria-hidden="true" />
          <span className={styles.cardTitle}>创建 Bundle 新版本</span>
        </div>
        <p className={styles.hint}>
          Bundle 变更必须创建新版本（旧版本保留可回滚）。skillRefKey 每行一个（可从「已安装」列表获取）。
        </p>
        <div className={styles.row}>
          <TextField value={bundleId} onChange={setBundleId} placeholder="bundleId（如 crew）" aria-label="bundleId" />
          <TextField value={name} onChange={setName} placeholder="名称" aria-label="名称" />
          <select
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
            aria-label="默认选择模式"
            className={styles.select ?? undefined}
          >
            <option value="implicit">implicit</option>
            <option value="explicit-only">explicit-only</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
        <textarea
          value={skillRefKeys}
          onChange={(event) => setSkillRefKeys(event.target.value)}
          placeholder={"每行一个 skillRefKey，例如：\nmy-skill@C:\\opencolorful\\skills\\installed\\my-skill@1.0.0"}
          aria-label="skillRefKey 列表"
          rows={4}
          className={styles.textarea ?? undefined}
        />
        <div className={styles.actions}>
          <Button size="sm" onClick={() => void createVersion()} disabled={creating} data-testid="bundle-create-version">
            {creating ? "创建中…" : "创建新版本"}
          </Button>
        </div>
      </div>

      {error !== null && <div className={styles.errorBlock}>{error}</div>}
      {note !== null && <p className={styles.note} role="status">{note}</p>}

      <h3 className={styles.sectionTitle}>Bundle 列表</h3>
      {bundles.length === 0 && <p className={styles.empty}>还没有 Bundle。</p>}
      {bundles.map((bundle) => (
        <div key={bundle.bundleId} className={styles.card} data-testid={`bundle-${bundle.bundleId}`}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>{bundle.bundleId}</span>
            <span className={styles.muted}>{bundle.name}</span>
            <span className={styles.muted}>{bundle.versions.length} 个版本</span>
          </div>
          <ul className={styles.list}>
            {bundle.versions.map((item) => (
              <li key={item.version} className={styles.bundleRow}>
                <span className={styles.code}>v{item.version}</span>
                <span className={styles.muted}>hash={shortHash(item.contentHash)}</span>
                <span className={styles.muted}>items={item.itemCount}</span>
                <span className={styles.muted}>{item.createdAt}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

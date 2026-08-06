import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Button, TextField } from "../../components/ui/index.js";
import { SkillApiClient, isSkillServiceUnavailable } from "../../lib/skill-api.js";
import type { SkillSearchHit, SkillSearchResult } from "../../lib/skill-types.js";
import { SkillInstallFlowCard } from "./SkillInstallFlowCard.js";
import { readinessTone, shortHash } from "./skill-format.js";
import { StatusPill } from "./skill-ui.js";
import styles from "./skills.module.css";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 发现视图（plans/phase-13.md §11.2 搜索顺序）
// 搜索与安装是两个独立动作：搜索绝不递归触发安装。
// ═══════════════════════════════════════════════════════════════

export interface DiscoverSkillsViewProps {
  readonly skillApi: SkillApiClient;
  readonly agentId?: string;
  readonly sessionId?: string;
}

const SCOPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "all", label: "全部层" },
  { value: "bound", label: "已绑定" },
  { value: "managed", label: "本地 Store" },
  { value: "workspace", label: "工作区/兼容目录" },
  { value: "plugin", label: "插件 Bundle" },
  { value: "remote", label: "远程来源" },
];

export function DiscoverSkillsView(props: DiscoverSkillsViewProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [result, setResult] = useState<SkillSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<{ sourceRef: string; kind: string; key: string } | null>(null);

  const search = useCallback(async (needle: string, scopeValue: string) => {
    setLoading(true);
    setError(null);
    setInstallFor(null);
    try {
      const found = await props.skillApi.searchSkills(needle, scopeValue);
      setResult(found);
    } catch (cause) {
      setResult(null);
      setError(isSkillServiceUnavailable(cause) ? "Skill 服务未就绪。" : cause instanceof Error ? cause.message : "搜索失败");
    } finally {
      setLoading(false);
    }
  }, [props.skillApi]);

  useEffect(() => {
    void search("", "all");
  }, [search]);

  return (
    <div>
      <div className={styles.searchBar}>
        <TextField
          value={query}
          onChange={setQuery}
          placeholder="搜索名称 / skillId / 描述…"
          aria-label="Skill 搜索词"
        />
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          aria-label="搜索范围"
          className={styles.select ?? undefined}
        >
          {SCOPES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <Button size="sm" onClick={() => void search(query, scope)} disabled={loading}>
          <Search size={12} aria-hidden="true" /> 搜索
        </Button>
      </div>

      {error !== null && <div className={styles.errorBlock}>{error}</div>}
      {result !== null && (
        <>
          <p className={styles.hint}>
            命中 {result.hits.length} 项；层：{result.layers.join(" → ")}；remote=
            {result.remote.available ? "可用" : "不可用"}（{result.remote.note}）
          </p>
          {result.diagnostics.map((diagnostic, index) => (
            <p className={styles.warn} key={`diag-${index}`}>
              诊断[{diagnostic.code}]：{diagnostic.message}
            </p>
          ))}
          {result.hits.length === 0 && <p className={styles.empty}>没有匹配的 Skill（搜索不会自动触发安装）。</p>}
          <ul className={styles.list}>
            {result.hits.map((hit) => (
              <SearchHitRow
                key={`${hit.layer}-${hit.skillRefKey ?? hit.sourceId}`}
                hit={hit}
                onInstall={() => setInstallFor({ sourceRef: hit.sourceId, kind: hit.installHint?.kind ?? "local", key: `${hit.layer}-${hit.sourceId}` })}
                canInstall={hit.installHint !== undefined}
                installing={installFor !== null && installFor.key === `${hit.layer}-${hit.sourceId}`}
                skillApi={props.skillApi}
                {...(props.agentId !== undefined ? { agentId: props.agentId } : {})}
                {...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {})}
                onSettled={() => {
                  setInstallFor(null);
                  void search(query, scope);
                }}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SearchHitRow(props: {
  readonly hit: SkillSearchHit;
  readonly skillApi: SkillApiClient;
  readonly onInstall: () => void;
  readonly canInstall: boolean;
  readonly installing: boolean;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly onSettled: () => void;
}) {
  const { hit } = props;
  return (
    <li className={styles.card} data-testid={`skill-hit-${hit.skillId}`}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{hit.displayName}</span>
        <StatusPill tone="muted">[{hit.layer}]</StatusPill>
        <StatusPill tone={readinessTone(hit.readiness)}>{hit.readiness ?? "?"}</StatusPill>
        {hit.pinned === true && <StatusPill tone="ok">已固定</StatusPill>}
        <span className={styles.muted}>v{hit.version}</span>
      </div>
      {hit.description !== undefined && <p className={styles.muted}>{hit.description}</p>}
      <p className={styles.muted}>
        skillId={hit.skillId}；来源={hit.sourceKind}；哈希={shortHash(hit.contentHash)}
        {hit.bindable ? "；可直接绑定" : "；需先安装"}
      </p>
      {props.installing && props.canInstall && (
        <SkillInstallFlowCard
          skillApi={props.skillApi}
          sourceRef={hit.sourceId}
          kind={hit.installHint?.kind ?? "local"}
          {...(props.agentId !== undefined ? { agentId: props.agentId } : {})}
          {...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {})}
          onSettled={props.onSettled}
        />
      )}
      {props.canInstall && !props.installing && (
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={props.onInstall}>
            安装（来源 {hit.sourceId}）
          </Button>
        </div>
      )}
    </li>
  );
}

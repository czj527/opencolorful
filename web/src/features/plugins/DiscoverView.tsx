import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type {
  CompatibilityReport,
  PluginInspectResult,
  PluginInstallPermission,
  PluginPermissionRequest,
  PluginSource,
  PluginSourceSearchQuery,
  PluginSourceSearchResult,
} from "../../lib/plugin-types.js";
import { capabilityLabel, PLUGIN_SOURCE_LABEL, PLUGIN_TRUST_LABEL } from "./plugin-format.js";
import {
  CompatibilityStatusPill,
  ErrorBlock,
  LoadingBlock,
  PluginServiceUnavailable,
  StatusPill,
} from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface DiscoverViewProps {
  readonly pluginApi: PluginApiClient;
}

type SourcesState = "loading" | "ready" | "unavailable";

export function DiscoverView(props: DiscoverViewProps) {
  const [sources, setSources] = useState<readonly PluginSource[]>([]);
  const [sourcesState, setSourcesState] = useState<SourcesState>("loading");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly PluginSourceSearchResult[] | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<PluginInspectResult | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [grantDecisions, setGrantDecisions] = useState<Readonly<Record<string, boolean>>>({});
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedNotice, setInstalledNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.pluginApi.listPluginSources();
        if (cancelled) return;
        setSources(list);
        setSourcesState("ready");
        // Server 来源可能只有 {sourceType, label, supported}：缺 id 时回退 sourceType
        if (list.length > 0) setSelectedSourceId(list[0]?.id ?? list[0]?.sourceType ?? "");
      } catch {
        if (!cancelled) setSourcesState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.pluginApi]);

  const selectedSource = sources.find((s) => (s.id ?? s.sourceType) === selectedSourceId) ?? null;

  const handleSearch = useCallback(async () => {
    if (query.trim().length === 0) {
      setSearchError("请输入要搜索的插件名称、包名或本地目录路径。");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setResults(null);
    setInspect(null);
    setInspectId(null);
    try {
      const searchInput: PluginSourceSearchQuery = {
        query: query.trim(),
        ...(selectedSource !== null
          ? { sourceId: selectedSource.id ?? selectedSource.sourceType, sourceType: selectedSource.sourceType }
          : {}),
      };
      const found = await props.pluginApi.searchPluginSources(searchInput);
      setResults(found);
      if (found.length === 0) setSearchError("未找到匹配的插件。");
    } catch (error) {
      setSearchError(
        error instanceof Error
          ? (isPluginServiceUnavailable(error)
              ? "插件来源搜索服务未就绪（/api/plugin-sources 未接入）。"
              : `搜索失败：${error.message}`)
          : "搜索失败。",
      );
    } finally {
      setSearching(false);
    }
  }, [query, selectedSource, props.pluginApi]);

  const handleInspect = useCallback(async (result: PluginSourceSearchResult) => {
    setInspectId(result.pluginId);
    setInspect(null);
    setInspectError(null);
    setInstalledNotice(null);
    setInstallError(null);
    setInspecting(true);
    try {
      const report = await props.pluginApi.inspectPlugin({ sourceRef: result.sourceRef });
      setInspect(report);
      const initial: Record<string, boolean> = {};
      for (const permission of report.manifest.permissions) {
        initial[permission.capability] = true;
      }
      setGrantDecisions(initial);
    } catch (error) {
      setInspectError(error instanceof Error ? `检查失败：${error.message}` : "检查失败。");
    } finally {
      setInspecting(false);
    }
  }, [props.pluginApi]);

  const handleInstall = useCallback(async () => {
    if (inspect === null) return;
    const permissions: readonly PluginInstallPermission[] = inspect.manifest.permissions.map(
      (permission) => ({ capability: permission.capability, decision: grantDecisions[permission.capability] ? "allowed" : "denied" }),
    );
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await props.pluginApi.installPlugin({
        sourceRef: inspect.manifest.source.sourceRef,
        permissions,
      });
      setInstalledNotice(`插件「${result.pluginId}」已安装（v${result.version}）。`);
      setInspect(null);
      setInspectId(null);
    } catch (error) {
      setInstallError(error instanceof Error ? `安装失败：${error.message}` : "安装失败。");
    } finally {
      setInstalling(false);
    }
  }, [inspect, grantDecisions, props.pluginApi]);

  const toggleGrant = (capability: string) => {
    setGrantDecisions((current) => ({ ...current, [capability]: !(current[capability] ?? true) }));
  };

  return (
    <div data-testid="discover-view">
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder={selectedSource === null ? "搜索插件名称 / 本地目录路径…" : `在「${selectedSource.name ?? selectedSource.label}」中搜索…`}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSearch();
          }}
          aria-label="插件搜索"
        />
        {sourcesState === "ready" && (
          <select
            className={styles.searchInput}
            value={selectedSourceId}
            onChange={(event) => setSelectedSourceId(event.currentTarget.value)}
            aria-label="来源选择"
            style={{ flex: "0 1 auto", minWidth: 140 }}
          >
            {sources.map((source) => (
              <option key={source.id ?? source.sourceType} value={source.id ?? source.sourceType}>
                {source.name ?? source.label}（{PLUGIN_SOURCE_LABEL[source.sourceType]}）
              </option>
            ))}
          </select>
        )}
        <Button variant="primary" size="sm" loading={searching} onClick={() => void handleSearch()}>
          <Search size={14} aria-hidden="true" />
          搜索
        </Button>
      </div>

      {sourcesState === "loading" && <LoadingBlock />}
      {sourcesState === "unavailable" && (
        <div className={styles.errorBlock} role="alert">
          来源服务未就绪（/api/plugin-sources 未接入）。下方搜索仍可尝试，但需要来源数据才能安装。
        </div>
      )}

      {searchError !== null && <ErrorBlock message={searchError} />}
      {installError !== null && <ErrorBlock message={installError} />}
      {installedNotice !== null && (
        <div className={styles.pillOk} style={{ marginBottom: "var(--space-12)" }} role="status">
          {installedNotice}
        </div>
      )}

      {inspecting && <LoadingBlock />}
      {inspect === null && inspectId !== null && inspectError !== null && <ErrorBlock message={inspectError} />}

      {inspect !== null && (
        <section className={styles.confirm} data-testid="install-confirm">
          <h3 className={styles.confirmTitle}>安装确认</h3>
          <CompatibilitySummary compatibility={inspect.compatibility} />
          <div className={styles.confirmGrid}>
            <ConfirmCell label="来源" value={PLUGIN_SOURCE_LABEL[inspect.manifest.source.sourceRef.sourceType]} />
            <ConfirmCell label="地址" value={inspect.manifest.source.sourceRef.ref} />
            <ConfirmCell label="版本" value={`v${inspect.manifest.version}`} />
            <ConfirmCell label="信任级别" value={PLUGIN_TRUST_LABEL[inspect.manifest.trust]} />
            <ConfirmCell
              label="校验 SHA-256"
              value={inspect.manifest.source.verification.sha256}
              monospace
            />
          </div>

          {inspect.manifest.trust === "full-access" && (
            <div className={styles.riskWarning} role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              该插件声明 full-access：代码将在独立进程中以本机完整权限运行，平台无法提供操作系统级沙箱。安装即意味着允许其读取/写入文件系统、建立网络连接或启动子进程。请仅在信任来源时继续。
            </div>
          )}

          <p className={styles.hint}>权限申请（可逐项授权或拒绝，安装后也可在「权限」视图调整）：</p>
          <PermissionChecklist
            permissions={inspect.manifest.permissions}
            decisions={grantDecisions}
            onToggle={toggleGrant}
          />

          {inspect.compatibility.missingCapabilities.length > 0 && (
            <>
              <p className={styles.hint}>缺失能力：</p>
              <ul className={styles.permList}>
                {inspect.compatibility.missingCapabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            </>
          )}

          <div className={styles.confirmActions}>
            <Button size="sm" loading={installing} onClick={() => void handleInstall()}>
              确认安装
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setInspect(null); setInspectId(null); }}>
              取消
            </Button>
          </div>
        </section>
      )}

      {results !== null && inspect === null && !inspecting && (
        <ul className={styles.list} data-testid="discover-results">
          {results.map((result) => (
            <li key={`${result.pluginId}@${result.version}`} className={styles.card}>
              <div className={styles.cardMain}>
                <span className={styles.cardTitle}>{result.name}</span>
                <span className={styles.cardMeta}>
                  <span>{result.pluginId}</span>
                  <span>v{result.version}</span>
                  <StatusPill tone={compatTone(result.compatibility)}>
                    {result.compatibility.supported ? "可安装" : "不兼容"}
                  </StatusPill>
                  {result.compatibility.requiresFullAccess && <StatusPill tone="danger">full-access</StatusPill>}
                </span>
              </div>
              {result.description !== undefined && <p className={styles.cardDesc}>{result.description}</p>}
              <div className={styles.cardActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={inspecting && inspectId === result.pluginId}
                  onClick={() => void handleInspect(result)}
                >
                  检查详情与安装
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function compatTone(report: CompatibilityReport): "ok" | "warn" {
  return report.supported ? "ok" : "warn";
}

function CompatibilitySummary({ compatibility }: { readonly compatibility: CompatibilityReport }) {
  return (
    <div className={styles.cardMeta}>
      <span>兼容等级 {compatibility.level}</span>
      <CompatibilityStatusPill status={compatibility.supported ? "supported" : "blocked"} />
      {compatibility.requiresFullAccess && <StatusPill tone="danger">full-access</StatusPill>}
    </div>
  );
}

function ConfirmCell(props: { readonly label: string; readonly value: string; readonly monospace?: boolean }) {
  return (
    <div className={styles.confirmCell}>
      <span className={styles.confirmCellLabel}>{props.label}</span>
      <span className={props.monospace === true ? `${styles.confirmCellValue} ${styles.hash}` : styles.confirmCellValue}>
        {props.value}
      </span>
    </div>
  );
}

function PermissionChecklist(props: {
  readonly permissions: readonly PluginPermissionRequest[];
  readonly decisions: Readonly<Record<string, boolean>>;
  readonly onToggle: (capability: string) => void;
}) {
  if (props.permissions.length === 0) {
    return <p className={styles.emptyHint}>该插件不申请任何权限。</p>;
  }
  return (
    <ul className={styles.compatList}>
      {props.permissions.map((permission) => {
        const granted = props.decisions[permission.capability] ?? true;
        return (
          <li key={permission.capability} className={styles.compatItem}>
            <label className={styles.compatItem}>
              <input
                type="checkbox"
                checked={granted}
                onChange={() => props.onToggle(permission.capability)}
                aria-label={`授权 ${capabilityLabel(permission.capability)}`}
              />
              <span className={styles.compatName}>{capabilityLabel(permission.capability)}</span>
              {permission.reason !== undefined && (
                <span className={styles.compatReason}>{permission.reason}</span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

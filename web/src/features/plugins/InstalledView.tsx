import { useCallback, useEffect, useState } from "react";
import { Pause, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type { PluginListItem } from "../../lib/plugin-types.js";
import { isPluginEnabled, PLUGIN_RUNTIME_LABEL, PLUGIN_SOURCE_LABEL } from "./plugin-format.js";
import {
  ErrorBlock,
  LoadingBlock,
  PluginHealthPill,
  PluginServiceUnavailable,
  PluginStatusPill,
  StatusPill,
} from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface InstalledViewProps {
  readonly pluginApi: PluginApiClient;
  readonly onOpenDetail: (pluginId: string) => void;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function InstalledView(props: InstalledViewProps) {
  const [plugins, setPlugins] = useState<readonly PluginListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const list = await props.pluginApi.listPlugins();
      setPlugins(list);
      setLoadState("ready");
    } catch (error) {
      if (isPluginServiceUnavailable(error)) {
        setLoadState("unavailable");
      } else {
        setLoadState("error");
      }
    }
  }, [props.pluginApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(async (id: string, action: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? `${action}失败：${error.message}` : `${action}失败`);
    } finally {
      setBusyId(null);
    }
  }, [load]);

  if (loadState === "loading") return <LoadingBlock />;
  if (loadState === "unavailable") return <PluginServiceUnavailable />;
  if (loadState === "error") {
    return <ErrorBlock message="已安装插件加载失败，请稍后重试。" />;
  }

  if (plugins.length === 0) {
    return <p className={styles.emptyHint}>暂无已安装插件。前往「发现」视图搜索并安装第一个插件。</p>;
  }

  return (
    <div data-testid="installed-view">
      {actionError !== null && <ErrorBlock message={actionError} />}
      <ul className={styles.list}>
        {plugins.map((plugin) => {
          const busy = busyId === plugin.pluginId;
          return (
            <li
              key={plugin.pluginId}
              className={styles.card}
              data-testid={`plugin-card-${plugin.pluginId}`}
            >
              <div
                className={`${styles.cardMain} ${styles.clickable}`}
                role="button"
                tabIndex={0}
                onClick={() => props.onOpenDetail(plugin.pluginId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onOpenDetail(plugin.pluginId);
                  }
                }}
                data-testid={`plugin-open-${plugin.pluginId}`}
              >
                <span className={styles.cardTitle}>{plugin.name ?? plugin.pluginId}</span>
                <span className={styles.cardMeta}>
                  <span>{plugin.pluginId}</span>
                  <span>v{plugin.version}</span>
                  <PluginStatusPill status={plugin.status} />
                  <PluginHealthPill health={plugin.health} />
                  {plugin.requiresFullAccess === true && <StatusPill tone="danger">full-access</StatusPill>}
                </span>
              </div>
              <span className={styles.cardMeta}>
                <span>{plugin.runtimeKind !== undefined ? PLUGIN_RUNTIME_LABEL[plugin.runtimeKind] : "—"}</span>
                <span>·</span>
                <span>{PLUGIN_SOURCE_LABEL[plugin.sourceType]}</span>
                <span>·</span>
                <span>安装于 {new Date(plugin.installedAt).toLocaleString()}</span>
              </span>
              <div className={styles.cardActions}>
                {isPluginEnabled(plugin) ? (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void runAction(plugin.pluginId, "禁用", () => props.pluginApi.disablePlugin(plugin.pluginId))}>
                    <Pause size={14} aria-hidden="true" />
                    禁用
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void runAction(plugin.pluginId, "启用", () => props.pluginApi.enablePlugin(plugin.pluginId))}>
                    <Play size={14} aria-hidden="true" />
                    启用
                  </Button>
                )}
                {plugin.updateAvailable != null && (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void runAction(plugin.pluginId, "更新", () => props.pluginApi.updatePlugin(plugin.pluginId))}>
                    <RefreshCw size={14} aria-hidden="true" />
                    更新至 {plugin.updateAvailable}
                  </Button>
                )}
                {plugin.rollbackAvailable === true && (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void runAction(plugin.pluginId, "回滚", () => props.pluginApi.rollbackPlugin(plugin.pluginId))}>
                    <RotateCcw size={14} aria-hidden="true" />
                    回滚
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy}
                  onClick={() => {
                    if (!window.confirm(`确认卸载插件「${plugin.name ?? plugin.pluginId}」？卸载会停止 Runtime 与 Surface，保留审计记录。`)) return;
                    void runAction(plugin.pluginId, "卸载", () => props.pluginApi.uninstallPlugin(plugin.pluginId));
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  卸载
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

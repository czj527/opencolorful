import { useEffect, useState } from "react";
import { Library } from "lucide-react";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type { PluginSource } from "../../lib/plugin-types.js";
import { PLUGIN_SOURCE_LABEL } from "./plugin-format.js";
import { ErrorBlock, LoadingBlock, PluginServiceUnavailable, StatusPill } from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface SourcesViewProps {
  readonly pluginApi: PluginApiClient;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function SourcesView(props: SourcesViewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [sources, setSources] = useState<readonly PluginSource[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.pluginApi.listPluginSources();
        if (cancelled) return;
        setSources(list);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setLoadState(isPluginServiceUnavailable(error) ? "unavailable" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.pluginApi]);

  if (loadState === "loading") return <LoadingBlock />;
  if (loadState === "unavailable") return <PluginServiceUnavailable />;
  if (loadState === "error") return <ErrorBlock message="来源列表加载失败，请稍后重试。" />;

  return (
    <div data-testid="sources-view">
      <p className={styles.hint}>
        Source Adapter 与 Runtime Adapter 分离：市场只负责发现和获取 Artifact，不能直接启用或执行插件。
        可信策略决定了来源可以被信任到哪个级别。
      </p>
      {sources.length === 0 && <p className={styles.emptyHint}>暂无已配置的插件来源。</p>}
      <ul className={styles.list}>
        {sources.map((source) => (
          <li key={source.id} className={styles.card}>
            <div className={styles.cardMain}>
              <Library size={16} aria-hidden="true" />
              <span className={styles.cardTitle}>{source.name}</span>
              <span className={styles.cardMeta}>
                <span>{PLUGIN_SOURCE_LABEL[source.sourceType]}</span>
                <StatusPill tone={source.trusted ? "ok" : "warn"}>
                  {source.trusted ? "已信任" : "未信任"}
                </StatusPill>
                <StatusPill tone={source.trustLevel === "full-access" ? "danger" : "muted"}>
                  {source.trustLevel === "none" ? "不可执行代码" : source.trustLevel === "restricted" ? "受限信任" : "完全信任（高危）"}
                </StatusPill>
              </span>
            </div>
            <p className={styles.cardDesc}>{source.description ?? source.ref}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

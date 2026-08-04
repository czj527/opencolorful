import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type {
  AgentPluginBinding,
  PluginContributions,
  PluginDetail,
  PluginInstallView,
} from "../../lib/plugin-types.js";
import { contributionKindLabel } from "../plugins/plugin-format.js";
import { ErrorBlock, LoadingBlock, PluginServiceUnavailable, StatusPill } from "../plugins/plugin-ui.js";
import styles from "./AgentPluginsSection.module.css";

export interface AgentPluginsSectionProps {
  readonly agentId: string;
  readonly pluginApi: PluginApiClient;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

interface BindingEntry {
  readonly pluginId: string;
  readonly binding: AgentPluginBinding | null;
}

interface ContributionRef {
  readonly id: string;
  readonly kind: string;
}

/** 平铺插件声明的所有 contribution（id + 种类，用于 per-Agent contribution 选择） */
function flattenContributions(contributions: PluginContributions | undefined): readonly ContributionRef[] {
  if (contributions === undefined) return [];
  const refs: ContributionRef[] = [];
  const groups: ReadonlyArray<readonly { readonly id: string }[] | undefined> = [
    contributions.tool,
    contributions.command,
    contributions.provider,
    contributions.route,
    contributions.page,
    contributions.widget,
    contributions["chat-surface"],
    contributions.background,
    contributions.hook,
    contributions.config,
    contributions.secret,
    contributions["context-attachment"],
    contributions["custom-activity"],
    contributions["skill-bundle"],
  ];
  const kinds = [
    "tool", "command", "provider", "route", "page", "widget", "chat-surface",
    "background", "hook", "config", "secret", "context-attachment", "custom-activity", "skill-bundle",
  ] as const;
  groups.forEach((group, index) => {
    if (group !== undefined) {
      const kind = kinds[index] ?? "tool";
      for (const item of group) refs.push({ id: item.id, kind });
    }
  });
  return refs;
}

export function AgentPluginsSection(props: AgentPluginsSectionProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [enabledPlugins, setEnabledPlugins] = useState<readonly PluginInstallView[]>([]);
  const [bindingMap, setBindingMap] = useState<Readonly<Record<string, AgentPluginBinding | null>>>({});
  const [detailMap, setDetailMap] = useState<Readonly<Record<string, PluginDetail | null>>>({});
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [plugins, bindings] = await Promise.all([
        props.pluginApi.listPlugins(),
        props.pluginApi.listAgentBindings(props.agentId),
      ]);
      const byPlugin: Record<string, AgentPluginBinding | null> = {};
      for (const binding of bindings) byPlugin[binding.pluginId] = binding;
      setEnabledPlugins(plugins.filter((plugin) => plugin.enabled));
      setBindingMap(byPlugin);
      setLoadState("ready");
    } catch (cause) {
      setLoadState(isPluginServiceUnavailable(cause) ? "unavailable" : "error");
    }
  }, [props.pluginApi, props.agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const entries: readonly BindingEntry[] = enabledPlugins.map((plugin) => ({
    pluginId: plugin.pluginId,
    binding: bindingMap[plugin.pluginId] ?? null,
  }));

  const ensureDetail = useCallback(async (pluginId: string) => {
    if (detailMap[pluginId] !== undefined) return detailMap[pluginId];
    try {
      const detail = await props.pluginApi.getPlugin(pluginId);
      setDetailMap((current) => ({ ...current, [pluginId]: detail }));
      return detail;
    } catch {
      return null;
    }
  }, [detailMap, props.pluginApi]);

  const bind = useCallback(async (pluginId: string) => {
    setBusyPluginId(pluginId);
    setError(null);
    setNote(null);
    try {
      const detail = await ensureDetail(pluginId);
      const allowed = detail === null ? [] : flattenContributions(detail.manifest?.contributions).map((ref) => ref.id);
      await props.pluginApi.bindPluginToAgent(props.agentId, pluginId, { contributions: allowed, enabled: true });
      setBindingMap((current) => ({
        ...current,
        [pluginId]: {
          agentId: props.agentId,
          pluginId,
          contributions: allowed,
          grantRevision: 0,
          enabled: true,
          updatedAt: new Date().toISOString(),
          revision: 0,
        },
      }));
      setNote("绑定已保存，下一 turn 生效。in-flight turn 继续使用不可变的执行快照。");
    } catch (cause) {
      setError(cause instanceof Error ? `绑定失败：${cause.message}` : "绑定失败。");
    } finally {
      setBusyPluginId(null);
    }
  }, [ensureDetail, props.agentId, props.pluginApi]);

  const unbind = useCallback(async (pluginId: string) => {
    setBusyPluginId(pluginId);
    setError(null);
    setNote(null);
    try {
      await props.pluginApi.unbindPluginFromAgent(props.agentId, pluginId);
      setBindingMap((current) => ({ ...current, [pluginId]: null }));
      setNote("解绑已保存，下一 turn 生效。");
    } catch (cause) {
      setError(cause instanceof Error ? `解绑失败：${cause.message}` : "解绑失败。");
    } finally {
      setBusyPluginId(null);
    }
  }, [props.agentId, props.pluginApi]);

  const updateContributions = useCallback(async (pluginId: string, contributions: readonly string[]) => {
    const current = bindingMap[pluginId];
    if (current === null || current === undefined) return;
    setBusyPluginId(pluginId);
    setError(null);
    setNote(null);
    try {
      await props.pluginApi.bindPluginToAgent(props.agentId, pluginId, { contributions, enabled: true });
      setBindingMap((currentMap) => ({
        ...currentMap,
        [pluginId]: { ...current, contributions, updatedAt: new Date().toISOString(), revision: current.revision + 1 },
      }));
      setNote("Contribution 选择已保存，下一 turn 生效。");
    } catch (cause) {
      setError(cause instanceof Error ? `保存失败：${cause.message}` : "保存失败。");
    } finally {
      setBusyPluginId(null);
    }
  }, [bindingMap, props.agentId, props.pluginApi]);

  const toggleContribution = (pluginId: string, contributionId: string) => {
    const current = bindingMap[pluginId];
    if (current === null || current === undefined) return;
    const next = current.contributions.includes(contributionId)
      ? current.contributions.filter((id) => id !== contributionId)
      : [...current.contributions, contributionId];
    void updateContributions(pluginId, next);
  };

  return (
    <section className={styles.root} data-testid="agent-plugins-section">
      <h3 className={styles.title}>插件绑定</h3>
      <p className={styles.hint}>
        为 Agent 绑定已启用的插件。绑定、contribution 选择与权限变更从<strong>下一 turn 生效</strong>；
        当前 in-flight turn 继续使用不可变的执行快照，不会中途切换工具实现。
      </p>

      {loadState === "loading" && <LoadingBlock />}
      {loadState === "unavailable" && <PluginServiceUnavailable detail="Agent 插件绑定 API（/api/agents/:id/plugins）尚未接入。Agent 身份与底色编辑不受影响。" />}
      {loadState === "error" && <ErrorBlock message="插件绑定数据加载失败。" />}

      {error !== null && <ErrorBlock message={error} />}
      {note !== null && (
        <p className={styles.note} role="status">{note}</p>
      )}

      {loadState === "ready" && entries.length === 0 && (
        <p className={styles.emptyHint}>没有已启用的插件。先在「插件中心 → 已安装」启用插件，再回来绑定。</p>
      )}

      {loadState === "ready" && (
        <ul className={styles.list}>
          {entries.map((entry) => {
          const bound = entry.binding !== null;
          const busy = busyPluginId === entry.pluginId;
          const detail = detailMap[entry.pluginId];
          const contributions = detail === null || detail === undefined
            ? []
            : flattenContributions(detail.manifest?.contributions);
          const contributionIds = contributions.map((ref) => ref.id);
          return (
            <li key={entry.pluginId} className={styles.card}>
              <div className={styles.cardMain}>
                <Boxes size={16} aria-hidden="true" />
                <span className={styles.name}>{entry.pluginId}</span>
                <StatusPill tone={bound ? "ok" : "muted"}>{bound ? "已绑定" : "未绑定"}</StatusPill>
                {busy && <span className={styles.hint}>保存中…</span>}
              </div>
              {bound && (
                <div className={styles.contribBlock}>
                  <span className={styles.hint}>允许的 contribution：</span>
                  {contributionIds.length === 0 && detail === undefined ? (
                    <Button size="sm" variant="ghost" onClick={() => void ensureDetail(entry.pluginId)}>
                      加载 contribution 列表
                    </Button>
                  ) : contributionIds.length === 0 ? (
                    <span className={styles.hint}>该插件未声明 contribution，或 Manifest 不可用（将绑定为允许全部）。</span>
                  ) : (
                    <ul className={styles.contribList}>
                      {contributionIds.map((contributionId) => {
                        const checked = entry.binding?.contributions.includes(contributionId) ?? true;
                        const kind = contributions.find((ref) => ref.id === contributionId)?.kind ?? "";
                        return (
                          <li key={contributionId}>
                            <label className={styles.contribItem}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleContribution(entry.pluginId, contributionId)}
                                aria-label={`允许 contribution ${contributionId}`}
                              />
                              <span>{contributionId}</span>
                              {kind !== "" && <span className={styles.kind}>{contributionKindLabel(kind)}</span>}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              <div className={styles.cardActions}>
                {bound ? (
                  <Button size="sm" variant="danger" loading={busy} onClick={() => void unbind(entry.pluginId)}>
                    解绑
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void bind(entry.pluginId)}>
                    绑定
                  </Button>
                )}
              </div>
            </li>
          );
          })}
        </ul>
      )}
    </section>
  );
}

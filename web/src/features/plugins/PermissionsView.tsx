import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, UserRound } from "lucide-react";
import { ApiClient } from "../../lib/api-client.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type {
  AgentPluginBinding,
  PluginDetail,
  PluginGrant,
} from "../../lib/plugin-types.js";
import { capabilityLabel } from "./plugin-format.js";
import { ErrorBlock, LoadingBlock, PluginServiceUnavailable, StatusPill } from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface PermissionsViewProps {
  readonly pluginApi: PluginApiClient;
  readonly api: ApiClient;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function PermissionsView(props: PermissionsViewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [grants, setGrants] = useState<readonly PluginGrant[]>([]);
  const [bindings, setBindings] = useState<readonly AgentPluginBinding[]>([]);
  const [agentNames, setAgentNames] = useState<Readonly<Record<string, string>>>({});

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const plugins = await props.pluginApi.listPlugins();
      // 平台级与 Agent 级授权通过插件详情聚合（GET /api/plugins/:id 返回 grants/agentBindings）
      const details = await Promise.allSettled(
        plugins.map((plugin) => props.pluginApi.getPlugin(plugin.pluginId)),
      );
      const collectedGrants: PluginGrant[] = [];
      const collectedBindings: AgentPluginBinding[] = [];
      for (const settled of details) {
        if (settled.status !== "fulfilled") continue;
        const detail: PluginDetail = settled.value;
        collectedGrants.push(...detail.grants);
        collectedBindings.push(...detail.agentBindings);
      }
      setGrants(collectedGrants);
      setBindings(collectedBindings);

      // Agent 名称仅用于展示；失败不影响授权表
      try {
        const agents = await props.api.listAgents();
        const names: Record<string, string> = {};
        for (const agent of agents) names[agent.identity.id] = agent.identity.name;
        setAgentNames(names);
      } catch {
        setAgentNames({});
      }
      setLoadState("ready");
    } catch (error) {
      if (isPluginServiceUnavailable(error)) {
        setLoadState("unavailable");
      } else {
        setLoadState("error");
      }
    }
  }, [props.pluginApi, props.api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === "loading") return <LoadingBlock />;
  if (loadState === "unavailable") return <PluginServiceUnavailable />;
  if (loadState === "error") return <ErrorBlock message="权限数据加载失败，请稍后重试。" />;

  return (
    <div data-testid="permissions-view">
      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>
          <ShieldCheck size={14} aria-hidden="true" />
          平台级授权（插件 × 能力）
        </h3>
        {grants.length === 0 && <p className={styles.emptyHint}>暂无平台级授权记录。安装插件时确认的权限会显示在这里。</p>}
        <ul className={styles.compatList}>
          {grants.map((grant, index) => (
            <li key={`${grant.pluginId}-${grant.capability}-${index}`} className={styles.compatItem}>
              <span className={styles.compatName}>{grant.pluginId}</span>
              <span>{capabilityLabel(grant.capability)}</span>
              <StatusPill tone={grant.decision === "allowed" ? "ok" : "danger"}>
                {grant.decision === "allowed" ? "已授权" : "已拒绝"}
              </StatusPill>
              <span className={styles.compatReason}>
                rev {grant.revision} · {grant.grantedBy}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.sectionCard} style={{ marginTop: "var(--space-16)" }}>
        <h3 className={styles.sectionTitle}>
          <UserRound size={14} aria-hidden="true" />
          Agent 级绑定
        </h3>
        <p className={styles.hint}>
          绑定变更从下一 turn 生效；in-flight turn 继续使用不可变的执行快照。在 Agent 编辑页可调整绑定与 contribution 选择。
        </p>
        {bindings.length === 0 && <p className={styles.emptyHint}>暂无 Agent 绑定。前往 Agent 编辑页绑定已启用插件。</p>}
        <ul className={styles.compatList}>
          {bindings.map((binding) => (
            <li key={`${binding.agentId}-${binding.pluginId}-${binding.revision}`} className={styles.compatItem}>
              <span className={styles.compatName}>{agentNames[binding.agentId] ?? binding.agentId}</span>
              <span>{binding.pluginId}</span>
              <StatusPill tone={binding.enabled ? "ok" : "muted"}>
                {binding.enabled ? "已绑定" : "已停用"}
              </StatusPill>
              <span className={styles.compatReason}>
                {binding.contributions.length === 0
                  ? "允许全部 contribution"
                  : `允许 ${binding.contributions.length} 个 contribution`}
                {binding.grantRevision > 0 ? ` · grant rev ${binding.grantRevision}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

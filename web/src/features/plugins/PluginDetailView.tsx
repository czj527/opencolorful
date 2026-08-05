import { useEffect, useState } from "react";
import { ArrowLeft, ScrollText } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import type {
  CompatibilityReport,
  PluginDetail,
  PluginDiagnostics,
  PluginGrant,
} from "../../lib/plugin-types.js";
import {
  buildPluginAssetUrl,
  capabilityLabel,
  contributionKindLabel,
  PLUGIN_RUNTIME_LABEL,
  PLUGIN_SOURCE_LABEL,
  PLUGIN_TRUST_LABEL,
} from "./plugin-format.js";
import {
  CompatibilityStatusPill,
  ErrorBlock,
  LoadingBlock,
  PluginHealthPill,
  PluginServiceUnavailable,
  PluginStatusPill,
  StatusPill,
} from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface PluginDetailViewProps {
  readonly pluginApi: PluginApiClient;
  readonly pluginId: string;
  readonly onBack: () => void;
}

type LoadState = "loading" | "ready" | "unavailable" | "error";

export function PluginDetailView(props: PluginDetailViewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const plugin = await props.pluginApi.getPlugin(props.pluginId);
        if (cancelled) return;
        setDetail(plugin);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setLoadState(isPluginServiceUnavailable(error) ? "unavailable" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.pluginApi, props.pluginId]);

  // 诊断独立加载：失败不影响详情主体
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await props.pluginApi.pluginDiagnostics(props.pluginId);
        if (cancelled) return;
        setDiagnostics(result);
      } catch (error) {
        if (cancelled) return;
        setDiagnosticsError(
          isPluginServiceUnavailable(error)
            ? "诊断端点（/api/plugins/:id/diagnostics）尚未接入。"
            : error instanceof Error ? error.message : "诊断加载失败。",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.pluginApi, props.pluginId]);

  if (loadState === "loading") return <LoadingBlock />;
  if (loadState === "unavailable") return <PluginServiceUnavailable />;
  if (loadState === "error" || detail === null) {
    return <ErrorBlock message="插件详情加载失败，请稍后重试。" />;
  }

  return (
    <div className={styles.detail} data-testid="plugin-detail">
      <header className={styles.cardMain}>
        <Button size="sm" variant="ghost" onClick={props.onBack} aria-label="返回插件列表">
          <ArrowLeft size={14} aria-hidden="true" />
          返回
        </Button>
        <span className={styles.cardTitle}>{detail.name ?? detail.pluginId}</span>
        <span className={styles.cardMeta}>
          <span>{detail.pluginId}</span>
          <span>v{detail.version}</span>
          <PluginStatusPill status={detail.status} />
          <PluginHealthPill health={detail.health} />
          {detail.requiresFullAccess === true && <StatusPill tone="danger">full-access</StatusPill>}
        </span>
      </header>

      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>概览</h3>
        <div className={styles.defList}>
          <DefItem k="信任级别" v={detail.trust !== undefined ? PLUGIN_TRUST_LABEL[detail.trust] : "—"} />
          <DefItem k="运行形态" v={detail.runtimeKind !== undefined ? PLUGIN_RUNTIME_LABEL[detail.runtimeKind] : "—"} />
          <DefItem k="来源类型" v={PLUGIN_SOURCE_LABEL[detail.sourceType ?? detail.source.sourceRef?.sourceType] ?? "—"} />
          <DefItem k="安装时间" v={new Date(detail.installedAt).toLocaleString()} />
          <DefItem k="更新" v={detail.updateAvailable === true ? "可更新" : "无可用更新"} />
          <DefItem k="回滚" v={detail.rollbackAvailable === true ? "可回滚" : "不可用"} />
        </div>
        {detail.runtime != null && (
          <div className={styles.defList} style={{ marginTop: "var(--space-12)" }}>
            <DefItem k="Runtime 实例" v={detail.runtime.runtimeInstanceId ?? "未启动"} />
            <DefItem k="启动时间" v={detail.runtime.startedAt == null ? "—" : new Date(detail.runtime.startedAt).toLocaleString()} />
            <DefItem k="Runtime 健康" v={detail.runtime.healthy === true ? "正常" : "异常"} />
          </div>
        )}
      </section>

      {detail.manifest != null && (
        <section className={styles.sectionCard}>
          <h3 className={styles.sectionTitle}>Manifest v1</h3>
          <p className={styles.cardDesc}>{detail.manifest.description ?? "无描述"}</p>
          <div className={styles.defList}>
            <DefItem k="ID" v={detail.manifest.id} />
            <DefItem k="名称" v={detail.manifest.name} />
            <DefItem k="版本" v={detail.manifest.version} />
            <DefItem k="作者" v={detail.manifest.author?.name ?? "—"} />
            <DefItem k="许可" v={detail.manifest.license ?? "—"} />
            <DefItem k="Host 要求" v={`opencolorful ${detail.manifest.compatibility.opencolorful} · pluginApi v${detail.manifest.compatibility.pluginApi}`} />
          </div>
        </section>
      )}

      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>来源与校验</h3>
        {detail.manifest != null ? (
          <div className={styles.defList}>
            <DefItem k="来源" v={PLUGIN_SOURCE_LABEL[detail.manifest.source.sourceRef.sourceType]} />
            <DefItem k="地址" v={detail.manifest.source.sourceRef.ref} />
            <DefItem
              k="SHA-256"
              v={detail.manifest.source.verification.sha256}
              mono
            />
            <DefItem k="大小" v={`${formatBytes(detail.manifest.source.verification.sizeBytes)}`} />
          </div>
        ) : (
          <p className={styles.emptyHint}>Manifest 不可用。</p>
        )}
      </section>

      {detail.compatibility != null && (
        <CompatibilitySection compatibility={detail.compatibility} />
      )}

      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>权限与授权</h3>
        {detail.manifest != null && (detail.manifest.permissions ?? []).length > 0 ? (
          <ul className={styles.permList}>
            {(detail.manifest.permissions ?? []).map((permission) => (
              <li key={permission.capability}>
                {capabilityLabel(permission.capability)}
                {permission.reason !== undefined ? ` — ${permission.reason}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptyHint}>该插件不申请权限。</p>
        )}
        <GrantList grants={detail.grants ?? []} />
      </section>

      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>配置与 Secret</h3>
        {(detail.secretStatus ?? []).length > 0 ? (
          <ul className={styles.compatList}>
            {(detail.secretStatus ?? []).map((secret) => (
              <li key={secret.name} className={styles.compatItem}>
                <span className={styles.compatName}>{secret.name}</span>
                <StatusPill tone={secret.configured ? "ok" : "warn"}>
                  {secret.configured ? "已配置" : "未配置"}
                </StatusPill>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptyHint}>无 Secret 声明。</p>
        )}
        {detail.configValues !== undefined && Object.keys(detail.configValues).length > 0 ? (
          <pre className={styles.devLog} data-testid="plugin-config-values">
            {JSON.stringify(detail.configValues, null, 2)}
          </pre>
        ) : (
          <p className={styles.emptyHint}>无配置值。</p>
        )}
      </section>

      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>UI Surface</h3>
        {(detail.surfaces ?? []).length === 0 ? (
          <p className={styles.emptyHint}>该插件未声明 UI Surface。</p>
        ) : (
          <ul className={styles.compatList}>
            {(detail.surfaces ?? []).map((surface) => {
              // Server 富化 assetUrl 优先；缺失时按受控资产路由约定由 entry 拼接
              const assetUrl =
                surface.assetUrl ??
                (surface.entry !== undefined ? buildPluginAssetUrl(detail.pluginId, surface.entry) : null);
              return (
                <li key={surface.surfaceId} className={styles.compatItem}>
                  <span className={styles.compatName}>{surface.name}</span>
                  <SurfaceHostEntry title={surface.name} assetUrl={assetUrl} />
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.hint} style={{ marginTop: "var(--space-8)" }}>
          Surface 资产经受控资产路由 GET /api/plugins/:id/assets/&lt;相对路径&gt; 托管；
          iframe 加载失败会被隔离在本区域，不影响聊天与设置主页面。
        </p>
      </section>

      <section className={styles.sectionCard} data-testid="plugin-diagnostics">
        <h3 className={styles.sectionTitle}>诊断</h3>
        {diagnosticsError !== null && <ErrorBlock message={diagnosticsError} />}
        {diagnostics !== null && (
          <>
            <div className={styles.cardMeta}>
              <PluginHealthPill health={diagnostics.health} />
              <span>
                生成于{" "}
                {diagnostics.generatedAt !== undefined ? new Date(diagnostics.generatedAt).toLocaleString() : "—"}
              </span>
            </div>
            {diagnostics.lastError != null && <ErrorBlock message={diagnostics.lastError} />}
            <ul className={styles.compatList}>
              {(diagnostics.checks ?? []).map((check) => (
                <li key={check.id} className={styles.compatItem}>
                  <StatusPill tone={check.ok ? "ok" : "danger"}>{check.ok ? "通过" : "失败"}</StatusPill>
                  <span className={styles.compatName}>{check.label}</span>
                  {check.message !== undefined && <span className={styles.compatReason}>{check.message}</span>}
                </li>
              ))}
            </ul>
            {(diagnostics.recentEvents ?? []).length > 0 && (
              <ul className={styles.compatList}>
                {(diagnostics.recentEvents ?? []).slice(0, 10).map((event) => (
                  <li key={`${event.recordedAt}-${event.eventName}`} className={styles.compatItem}>
                    <span className={styles.compatName}>{event.eventName}</span>
                    <span className={styles.compatReason}>{event.status ?? ""}</span>
                    {event.errorCode !== null && <span className={styles.compatReason}>{event.errorCode}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div style={{ marginTop: "var(--space-12)" }}>
          <Button size="sm" variant="ghost" onClick={() => openPrefilteredLogs(props.pluginId)}>
            <ScrollText size={14} aria-hidden="true" />
            查看相关日志（按 pluginId 预筛选）
          </Button>
        </div>
      </section>
    </div>
  );
}

function CompatibilitySection({ compatibility }: { readonly compatibility: CompatibilityReport }) {
  return (
    <section className={styles.sectionCard}>
      <h3 className={styles.sectionTitle}>兼容性报告</h3>
      <div className={styles.cardMeta}>
        <StatusPill tone={compatibility.supported ? "ok" : "danger"}>
          {compatibility.supported ? `兼容（L${compatibility.level.slice(1)}）` : "不兼容"}
        </StatusPill>
        <span>最高等级 {compatibility.level}</span>
        {compatibility.requiresFullAccess && <StatusPill tone="danger">full-access</StatusPill>}
      </div>
      {compatibility.missingCapabilities.length > 0 && (
        <>
          <p className={styles.hint}>缺失能力：</p>
          <ul className={styles.missingList}>
            {compatibility.missingCapabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </>
      )}
      {compatibility.contributions.length > 0 && (
        <ul className={styles.compatList}>
          {compatibility.contributions.map((item) => (
            <li key={`${item.kind}-${item.id}`} className={styles.compatItem}>
              <CompatibilityStatusPill status={item.status} />
              <span className={styles.compatName}>{contributionKindLabel(item.kind)} · {item.id}</span>
              {item.reason !== undefined && <span className={styles.compatReason}>{item.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {compatibility.blockedReasons.length > 0 && (
        <ul className={styles.missingList}>
          {compatibility.blockedReasons.map((reason) => (
            <li key={reason} className={styles.riskWarning} style={{ listStyle: "none" }}>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GrantList({ grants }: { readonly grants: readonly PluginGrant[] }) {
  if (grants.length === 0) {
    return <p className={styles.emptyHint}>暂无平台级授权。</p>;
  }
  return (
    <ul className={styles.compatList}>
      {grants.map((grant) => (
        <li key={`${grant.capability}-${grant.revision}`} className={styles.compatItem}>
          <span className={styles.compatName}>{capabilityLabel(grant.capability)}</span>
          <StatusPill tone={grant.decision === "allowed" ? "ok" : "danger"}>
            {grant.decision === "allowed" ? "已授权" : "已拒绝"}
          </StatusPill>
          <span className={styles.compatReason}>rev {grant.revision}</span>
        </li>
      ))}
    </ul>
  );
}

function SurfaceHostEntry(props: { readonly title: string; readonly assetUrl: string | null }) {
  return (
    <div className={styles.surfaceHost} data-testid="surface-host">
      <div className={styles.surfaceHeader}>
        <span>{props.title}</span>
      </div>
      {props.assetUrl !== null ? (
        // P0-1 Surface 隔离：资产经同源受控路由托管，但 iframe 必须 opaque origin——
        // 去掉 allow-same-origin（allow-scripts + allow-same-origin 组合等于无隔离，
        // 恶意 Surface 可访问父页面/同源存储/平台 API）。不提供顶层打开入口。
        <iframe
          className={styles.surfaceFrame}
          src={props.assetUrl}
          title={props.title}
          sandbox="allow-scripts"
          data-testid="surface-frame"
        />
      ) : (
        <div className={styles.surfaceFallback} role="alert">
          <span>该 Surface 未声明资源入口（entry），无法渲染插件 UI。</span>
          <span className={styles.hint}>
            Surface 资产经受控资产路由 GET /api/plugins/:id/assets/&lt;相对路径&gt; 托管；
            插件声明 entry 后将在此显示界面，加载失败不影响聊天与设置主页面。
          </span>
        </div>
      )}
    </div>
  );
}

function DefItem(props: { readonly k: string; readonly v: string; readonly mono?: boolean }) {
  return (
    <div className={styles.defItem}>
      <span className={styles.defKey}>{props.k}</span>
      <span className={props.mono === true ? `${styles.defValue} ${styles.hash}` : styles.defValue}>{props.v}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 按 pluginId 预筛选跳转 /logs（LogsPage 读取 ?plugin= 作为活动搜索初始值）。 */
function openPrefilteredLogs(pluginId: string): void {
  if (typeof window === "undefined") return;
  const target = `/logs?plugin=${encodeURIComponent(pluginId)}`;
  history.pushState({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

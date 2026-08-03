import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Brain, CircleAlert, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
import { Button, Card, EmptyState, Field, Select, Spinner, TextField, Toggle } from "../../components/ui/index.js";
import { SseClient } from "../../lib/sse-client.js";
import type { PlatformEventEnvelope } from "../../lib/types.js";
import { navigateToWorkspace } from "../../app/page-router.js";
import styles from "./MemoryPage.module.css";

export interface MemoryPageProps {
  readonly agentId?: string | null;
}

type JsonObject = Record<string, unknown>;
export interface MemoryCompiled { today?: string; week?: string; longterm?: string; facts?: string; }
export interface MemoryFact { id?: number | string; fact?: string; tags?: string[]; factTime?: string | null; createdAt?: string; confidence?: number; }
export interface MemoryEvent { id?: string; date?: string; startedAt?: string; endedAt?: string; summary?: string; topics?: string[]; sessionId?: string; messageCount?: number; toolCalls?: number; }
export interface MemoryHealth {
  recallEpisode?: JsonObject | null;
  recall?: JsonObject | null;
  /** 服务端返回 pending batch 数组（API/UI 契约：长度即待处理数） */
  pendingBatches?: number | JsonObject | Array<{ id?: string }>;
  batches?: JsonObject;
  watermarks?: JsonObject;
  scheduler?: JsonObject;
  latestRecallStatus?: string | null;
  latestRecallEpisodes?: Array<{ status?: string; resultCount?: number; layer?: string }>;
}
export interface TimelineFact { id?: number | string; fact?: string; retentionStrength?: number; activationStrength?: number; confidence?: number; status?: string; validUntil?: string | null; hitDates?: number; }
export interface TimelineEvent { id?: string; summary?: string; date?: string; salience?: number; status?: string; }
export interface MemoryAgentSettings {
  enabled: boolean;
  utilityProviderId: string | null;
  utilityModel: string | null;
  deepDiveMode: "script" | "experimental-agent";
  dailyRunTime: string;
  minIdleMinutes: number;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
  turnsPerSummary: number;
  injectBudgetChars: number;
  retentionThresholds: { mediumUp: number; mediumDown: number; permanentUp: number };
}
export type MaintenanceStatus = "queued" | "started" | "processing" | "completed" | "deferred" | "failed";
export interface MaintenanceState { status: MaintenanceStatus; phase?: string; runId?: string; reason?: string; at: string; }
interface MemoryData { compiled: MemoryCompiled; facts: MemoryFact[]; events: MemoryEvent[]; pinned: Array<{ id?: string; content?: string; createdAt?: string }>; health: MemoryHealth; }

const emptyData: MemoryData = { compiled: {}, facts: [], events: [], pinned: [], health: {} };
const text = (value: unknown, fallback = "—") => typeof value === "string" && value ? value : fallback;
const num = (value: unknown, fallback = "0") => typeof value === "number" ? String(value) : text(value, fallback);
const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const unwrap = <T,>(value: unknown, key: string): T => (value && typeof value === "object" && key in value ? (value as JsonObject)[key] : value) as T;
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`记忆服务暂不可用（${response.status}）`);
  return await response.json() as T;
}

function formatDate(value: unknown): string { if (!value) return "未知时间"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
function healthValue(health: MemoryHealth, key: string): unknown {
  const root = health as JsonObject;
  return health.recallEpisode?.[key] ?? health.recall?.[key] ?? root[key];
}

/** 后台整理状态文案（plan §8.3：正在整理往事 → 正在核对记忆 → 正在合并相近记忆 → 整理完成/整理延期） */
export function maintenanceLabel(status: MaintenanceStatus, phase?: string): string {
  switch (status) {
    case "queued": return "已排队";
    case "started": return "正在整理往事";
    case "processing": return phase === "策略审批" ? "正在合并相近记忆" : "正在核对记忆";
    case "completed": return "整理完成";
    case "deferred": return "整理延期";
    case "failed": return "整理失败";
  }
}

function maintenanceFromEvent(event: PlatformEventEnvelope): MaintenanceState | null {
  if (!event.type.startsWith("memory.agent.")) return null;
  const payload = event.payload as JsonObject;
  return {
    status: event.type.replace("memory.agent.", "") as MaintenanceStatus,
    ...(typeof payload["phase"] === "string" ? { phase: payload["phase"] } : {}),
    ...(typeof payload["runId"] === "string" ? { runId: payload["runId"] } : {}),
    ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] } : {}),
    at: event.timestamp,
  };
}

export function MemoryPage({ agentId }: MemoryPageProps) {
  const [data, setData] = useState<MemoryData>(emptyData);
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([]);  const [selectedAgent, setSelectedAgent] = useState(agentId ?? "");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<{ facts: TimelineFact[]; events: TimelineEvent[] }>({ facts: [], events: [] });
  const [settings, setSettings] = useState<MemoryAgentSettings | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [report, setReport] = useState<{ run: JsonObject; report: string } | null>(null);
  const [deepDiveBusy, setDeepDiveBusy] = useState(false);
  const sseRef = useRef<SseClient | null>(null);

  const load = useCallback(async (background = false) => {
    if (!selectedAgent) { setLoading(false); return; }
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const base = `/api/agents/${encodeURIComponent(selectedAgent)}/memory`;
      const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
      const [compiled, facts, events, pinned, health, timelineData, settingsData] = await Promise.all([
        getJson<MemoryCompiled>(`${base}/compiled`),
        getJson<MemoryFact[] | JsonObject>(`${base}/facts${search}`),
        getJson<MemoryEvent[] | JsonObject>(`${base}/events${search}`),
        getJson<Array<{ id?: string; content?: string; createdAt?: string }> | JsonObject>(`${base}/pinned`),
        getJson<MemoryHealth>(`${base}/health`),
        getJson<{ facts: TimelineFact[]; events: TimelineEvent[] } | JsonObject>(`${base}/timeline`),
        getJson<{ settings: MemoryAgentSettings } | JsonObject>(`${base}/settings`),
      ]);
      setData({
        compiled: unwrap<MemoryCompiled>(compiled, "sections") ?? {},
        facts: asArray<MemoryFact>(unwrap<unknown>(facts, "facts")),
        events: asArray<MemoryEvent>(unwrap<unknown>(events, "events")),
        pinned: asArray<{ id?: string; content?: string; createdAt?: string }>(unwrap<unknown>(pinned, "pinned")),
        health: unwrap<MemoryHealth>(health, "health") ?? {},
      });
      setTimeline({ facts: asArray<TimelineFact>(unwrap<unknown>(timelineData, "facts")), events: asArray<TimelineEvent>(unwrap<unknown>(timelineData, "events")) });
      const settingsBody = unwrap<unknown>(settingsData, "settings");
      if (settingsBody !== null && typeof settingsBody === "object" && "enabled" in (settingsBody as JsonObject)) {
        setSettings(settingsBody as MemoryAgentSettings);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "记忆加载失败"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [query, selectedAgent]);

  useEffect(() => { void getJson<Array<{ identity?: { id?: string; name?: string } }> | JsonObject>("/api/agents").then((value) => {
    const list: Array<{ id: string; name?: string }> = asArray<{ identity?: { id?: string; name?: string } }>(unwrap<unknown>(value, "agents"))
      .flatMap((item) => item.identity?.id
        ? [{ id: item.identity.id, ...(item.identity.name !== undefined ? { name: item.identity.name } : {}) }]
        : []);
    setAgents(list); if (!selectedAgent && list[0]) setSelectedAgent(list[0].id);
  }).catch(() => { /* the page still explains how to retry */ }); }, [selectedAgent]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!selectedAgent) return undefined; const timer = window.setInterval(() => void load(true), 15000); return () => window.clearInterval(timer); }, [load, selectedAgent]);

  // 后台整理状态：订阅 agent 事件流中的 memory.agent.*（不进入主对话消息流）
  useEffect(() => {
    if (!selectedAgent) return undefined;
    sseRef.current?.dispose();
    const sse = new SseClient({
      baseUrl: "",
      agentId: selectedAgent,
      onEvent: (event) => {
        if (!event.type.startsWith("memory.agent.")) return;
        const state = maintenanceFromEvent(event);
        if (state === null) return;
        setMaintenance(state);
        if (state.status === "completed" || state.status === "deferred" || state.status === "failed") {
          if (state.runId !== undefined) {
            getJson<{ run: JsonObject; report: string }>(`/api/agents/${encodeURIComponent(selectedAgent)}/memory/runs/${encodeURIComponent(state.runId)}`)
              .then((value) => setReport(value))
              .catch(() => setReport(null));
          }
        }
      },
      onError: () => { /* 断线自动重连，状态保持 */ },
    });
    try { sse.connect(); } catch { /* 环境不支持 EventSource（如测试）时静默降级 */ }
    sseRef.current = sse;
    return () => { sseRef.current?.dispose(); sseRef.current = null; };
  }, [selectedAgent]);

  const handleDeepDive = useCallback(async () => {
    if (!selectedAgent || deepDiveBusy) return;
    setDeepDiveBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgent)}/memory/deep-dive`, { method: "POST" });
      if (!response.ok) throw new Error(`整理排队失败（${response.status}）`);
      setMaintenance({ status: "queued", at: new Date().toISOString() });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "整理排队失败"); }
    finally { setDeepDiveBusy(false); }
  }, [selectedAgent, deepDiveBusy]);

  const handleSaveSettings = useCallback(async () => {
    if (!selectedAgent || settings === null) return;
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgent)}/memory/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error(`设置保存失败（${response.status}）`);
      setSavedAt(new Date().toISOString());
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "设置保存失败"); }
  }, [selectedAgent, settings]);

  const patchSettings = useCallback(<K extends keyof MemoryAgentSettings>(key: K, value: MemoryAgentSettings[K]) => {
    setSettings((current) => current === null ? current : { ...current, [key]: value });
  }, []);
  const patchThreshold = useCallback((key: keyof MemoryAgentSettings["retentionThresholds"], value: number) => {
    setSettings((current) => current === null ? current : { ...current, retentionThresholds: { ...current.retentionThresholds, [key]: value } });
  }, []);

  const filteredFacts = useMemo(() => query.trim() ? data.facts.filter((fact) => JSON.stringify(fact).toLowerCase().includes(query.toLowerCase())) : data.facts, [data.facts, query]);
  const filteredEvents = useMemo(() => query.trim() ? data.events.filter((event) => JSON.stringify(event).toLowerCase().includes(query.toLowerCase())) : data.events, [data.events, query]);
  const latestEpisode = asArray<{ status?: string; resultCount?: number; layer?: string }>(data.health.latestRecallEpisodes)[0];
  const recallStatus = typeof data.health.latestRecallStatus === "string" ? data.health.latestRecallStatus : (latestEpisode?.status ?? "idle");
  const pending = Array.isArray(data.health.pendingBatches)
    ? data.health.pendingBatches.length
    : typeof data.health.pendingBatches === "number" ? data.health.pendingBatches : text(data.health.batches, "0");
  const recallDetail = latestEpisode !== undefined
    ? `${text(latestEpisode.resultCount, "0")} 个结果 · ${text(latestEpisode.layer, "等待回想")}`
    : "0 个结果 · 等待回想";
  const maintenanceStatus = maintenance !== null ? maintenanceLabel(maintenance.status, maintenance.phase) : "空闲";

  return <main className={styles.page}>
    <header className={styles.header}><Button variant="ghost" size="sm" onClick={navigateToWorkspace} aria-label="返回工作台"><ArrowLeft size={16} /> 返回</Button><div><h1><Brain size={22} /> 记忆</h1><p>只读查看上下文记忆、事实与回想健康状态</p></div><Button variant="ghost" size="sm" onClick={() => void load(true)} loading={refreshing} aria-label="刷新记忆"><RefreshCw size={16} /> 刷新</Button></header>
    <div className={styles.toolbar}>
      {agents.length > 0 && <label className={styles.agent}>Agent<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name ?? agent.id}</option>)}</select></label>}
      <TextField value={query} onChange={setQuery} type="search" placeholder="搜索事实与事件…" aria-label="搜索记忆" />
    </div>
    {error && <div role="alert" className={styles.error}><CircleAlert size={17} /> {error}<Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button></div>}
    {!selectedAgent && !loading && <EmptyState title="还没有可查看的 Agent" description="选择一个 Agent 后，这里会显示它的只读记忆。" />}
    {loading ? <div className={styles.loading}><Spinner /> 正在加载记忆…</div> : selectedAgent && <>
      <section className={styles.healthGrid} aria-label="记忆健康状态"><Card><strong>RecallEpisode</strong><span className={styles.status}>{recallStatus}</span><small>{recallDetail}</small></Card><Card><strong>Pending batch</strong><span className={styles.status}>{pending}</span><small>封存队列状态</small></Card><Card><strong>后台整理</strong><span className={styles.status}>{maintenanceStatus}</span><small>{maintenance !== null && maintenance.runId !== undefined ? `run ${maintenance.runId.slice(0, 12)}… · ${formatDate(maintenance.at)}` : "空闲窗口每日运行"}</small></Card></section>
      <section className={styles.healthGrid} aria-label="后台整理控制">
        <Card as="section" className={styles.maintenanceCard ?? ""}>
          <div className={styles.cardTitle}><h2>后台整理</h2><span>{maintenanceStatus}</span></div>
          <p className={styles.muted}>整理不进入主 Agent 对话流：正在整理往事 → 正在核对记忆 → 正在合并相近记忆 → 整理完成/整理延期。</p>
          {maintenance !== null && maintenance.phase !== undefined && <p className={styles.muted}>阶段：{maintenance.phase}{maintenance.reason !== undefined ? ` · ${maintenance.reason}` : ""}</p>}
          <div className={styles.row}>
            <Button size="sm" onClick={() => void handleDeepDive()} loading={deepDiveBusy}><WandSparkles size={15} /> 立即整理</Button>
            {maintenance !== null && maintenance.runId !== undefined && <Button variant="ghost" size="sm" onClick={() => { getJson<{ run: JsonObject; report: string }>(`/api/agents/${encodeURIComponent(selectedAgent)}/memory/runs/${encodeURIComponent(maintenance.runId!)}`).then(setReport).catch(() => setReport(null)); }}>查看报告</Button>}
          </div>
          {report !== null && <details className={styles.report}><summary>最近运行报告（脱敏）</summary><pre>{report.report}</pre></details>}
        </Card>
        <Card as="section" className={styles.maintenanceCard ?? ""}>
          <div className={styles.cardTitle}><h2>整理设置</h2><span>{settings !== null ? (savedAt !== null ? `已保存 ${formatDate(savedAt)}` : "未修改") : ""}</span></div>
          {settings === null ? <p className={styles.muted}>设置加载失败或不可用。</p> : <>
            <div className={styles.settingsGrid}>
              <Field label="启用" htmlFor="mem-enabled"><Toggle id="mem-enabled" checked={settings.enabled} onChange={(checked) => patchSettings("enabled", checked)} /></Field>
              <Field label="每日整理时间" htmlFor="mem-daily" hint="24 小时制 HH:MM，空闲窗口触发"><TextField id="mem-daily" value={settings.dailyRunTime} onChange={(value) => patchSettings("dailyRunTime", value)} placeholder="03:00" /></Field>
              <Field label="最小空闲分钟" htmlFor="mem-idle"><TextField id="mem-idle" type="text" value={String(settings.minIdleMinutes)} onChange={(value) => patchSettings("minIdleMinutes", Number(value) || 0)} /></Field>
              <Field label="每周复核日" htmlFor="mem-weekday"><Select id="mem-weekday" value={String(settings.weeklyReviewDay)} onChange={(value) => patchSettings("weeklyReviewDay", Number(value))}>{WEEKDAY_LABELS.map((label, day) => <option key={day} value={String(day)}>{label}</option>)}</Select></Field>
              <Field label="每周复核时间" htmlFor="mem-weekly-time"><TextField id="mem-weekly-time" value={settings.weeklyReviewTime} onChange={(value) => patchSettings("weeklyReviewTime", value)} placeholder="03:30" /></Field>
              <Field label="每 N 轮小结" htmlFor="mem-turns"><TextField id="mem-turns" type="text" value={String(settings.turnsPerSummary)} onChange={(value) => patchSettings("turnsPerSummary", Number(value) || 1)} /></Field>
            </div>
            <div className={styles.settingsGrid}>
              <Field label="整理模式" htmlFor="mem-mode"><Select id="mem-mode" value={settings.deepDiveMode} onChange={(value) => patchSettings("deepDiveMode", value as "script" | "experimental-agent")}><option value="script">script</option><option value="experimental-agent">experimental-agent</option></Select></Field>
              <Field label="注入预算（字符）" htmlFor="mem-budget"><TextField id="mem-budget" type="text" value={String(settings.injectBudgetChars)} onChange={(value) => patchSettings("injectBudgetChars", Number(value) || 200)} /></Field>
              <Field label="中期提升阈值" htmlFor="mem-up" hint="强度 ≥ 此值进入中期"><TextField id="mem-up" type="text" value={String(settings.retentionThresholds.mediumUp)} onChange={(value) => patchThreshold("mediumUp", Number(value) || 1)} /></Field>
              <Field label="中期回落阈值" htmlFor="mem-down" hint="迟滞区间下限，低于此值才回落短期"><TextField id="mem-down" type="text" value={String(settings.retentionThresholds.mediumDown)} onChange={(value) => patchThreshold("mediumDown", Number(value) || 1)} /></Field>
              <Field label="永久提升阈值" htmlFor="mem-perm" hint="仍需多来源 + MemoryPolicy 审批"><TextField id="mem-perm" type="text" value={String(settings.retentionThresholds.permanentUp)} onChange={(value) => patchThreshold("permanentUp", Number(value) || 1)} /></Field>
            </div>
            <p className={styles.muted}>阈值调整仍受 MemoryPolicy 约束：不提供把权重直接调成“永久”的捷径；永久事实不自动衰减。</p>
            <div className={styles.row}><Button size="sm" onClick={() => void handleSaveSettings()}>保存设置</Button><span className={styles.muted}>保存后写入该 Agent 的独立设置，未覆盖项沿用全局默认。</span></div>
          </>}
        </Card>
      </section>
      <section><div className={styles.sectionTitle}><h2>编译记忆</h2><span>四段上下文制品</span></div><div className={styles.compiledGrid}>{([['today','今天'],['week','本周'],['longterm','长期'],['facts','重要事实']] as const).map(([key, label]) => <Card as="article" key={key}><h3>{label}</h3>{text(data.compiled[key], "暂无内容") !== "暂无内容" ? <pre>{data.compiled[key]}</pre> : <p className={styles.muted}>暂无内容</p>}</Card>)}</div></section>
      <section className={styles.columns}><Card as="section"><div className={styles.cardTitle}><h2>Pinned memories</h2><span>{data.pinned.length}</span></div>{data.pinned.length ? <ul>{data.pinned.map((item) => <li key={item.id ?? item.content}><Sparkles size={14} /><span>{text(item.content)}</span></li>)}</ul> : <p className={styles.muted}>暂无置顶记忆</p>}</Card><Card as="section"><div className={styles.cardTitle}><h2>已审批事实</h2><span>{filteredFacts.length}</span></div>{filteredFacts.length ? <ul>{filteredFacts.map((fact) => <li key={String(fact.id ?? fact.fact)}><strong>{text(fact.fact)}</strong><small>{fact.tags?.join(" · ") ?? ""}{fact.factTime ? ` · ${formatDate(fact.factTime)}` : ""}</small></li>)}</ul> : <p className={styles.muted}>暂无已审批事实</p>}</Card></section>
      <section><div className={styles.sectionTitle}><h2>强度时间线</h2><span>派生视图，不落库：retention 经提案审批，activation 由回想命中确定性更新</span></div>
        <Card as="section" aria-label="时间线事实强度"><div className={styles.cardTitle}><h3>事实双强度</h3><span>{timeline.facts.length}</span></div>{timeline.facts.length ? <ul className={styles.strengthList}>{timeline.facts.map((fact) => <li key={String(fact.id ?? fact.fact)}>
          <div className={styles.strengthHead}><strong>{text(fact.fact)}</strong><small>confidence {text(fact.confidence)} · {text(fact.status)} · <span>{`${num(fact.hitDates)} 个回想日`}</span>{fact.validUntil ? ` · 有效至 ${formatDate(fact.validUntil)}` : ""}</small></div>
          <div className={styles.barRow}><span>retention</span><div className={styles.bar}><div className={styles.barRetention} style={{ width: `${Math.min(100, Number(fact.retentionStrength ?? 0))}%` }} /></div><b>{num(fact.retentionStrength)}</b></div>
          <div className={styles.barRow}><span>activation</span><div className={styles.bar}><div className={styles.barActivation} style={{ width: `${Math.min(100, Number(fact.activationStrength ?? 0))}%` }} /></div><b>{num(fact.activationStrength)}</b></div>
        </li>)}</ul> : <p className={styles.muted}>暂无事实强度数据</p>}</Card>
        <Card as="section" aria-label="时间线事件显著度"><div className={styles.cardTitle}><h3>事件显著度</h3><span>{timeline.events.length}</span></div>{timeline.events.length ? <ul className={styles.strengthList}>{timeline.events.map((event) => <li key={event.id ?? `${event.date}-${event.summary}`}>
          <div className={styles.strengthHead}><strong>{text(event.summary, "未命名事件")}</strong><small>{formatDate(event.date)}{event.status ? ` · ${event.status}` : ""}</small></div>
          <div className={styles.barRow}><span>salience</span><div className={styles.bar}><div className={styles.barSalience} style={{ width: `${Math.min(100, Number(event.salience ?? 0))}%` }} /></div><b>{num(event.salience)}</b></div>
        </li>)}</ul> : <p className={styles.muted}>暂无显著度数据</p>}</Card>
      </section>
      <Card as="section"><div className={styles.cardTitle}><h2>事件时间线</h2><span>{filteredEvents.length}</span></div>{filteredEvents.length ? <ol className={styles.timeline}>{filteredEvents.map((event) => <li key={event.id ?? `${event.startedAt}-${event.summary}`}><time>{formatDate(event.startedAt ?? event.date)}</time><div><strong>{text(event.summary, "未命名事件")}</strong><small>{event.topics?.join(" · ") ?? ""}{event.sessionId ? ` · Session ${event.sessionId}` : ""}</small></div></li>)}</ol> : <p className={styles.muted}>暂无匹配事件</p>}</Card>
    </>}
  </main>;
}

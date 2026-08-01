import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Brain, CircleAlert, RefreshCw, Search, Sparkles } from "lucide-react";
import { Button, Card, EmptyState, Spinner, TextField } from "../../components/ui/index.js";
import { navigateToWorkspace } from "../../app/page-router.js";
import styles from "./MemoryPage.module.css";

export interface MemoryPageProps {
  readonly agentId?: string | null;
}

type JsonObject = Record<string, unknown>;
export interface MemoryCompiled { today?: string; week?: string; longterm?: string; facts?: string; }
export interface MemoryFact { id?: number | string; fact?: string; tags?: string[]; factTime?: string | null; createdAt?: string; confidence?: number; }
export interface MemoryEvent { id?: string; date?: string; startedAt?: string; endedAt?: string; summary?: string; topics?: string[]; sessionId?: string; messageCount?: number; toolCalls?: number; }
export interface MemoryHealth { recallEpisode?: JsonObject | null; recall?: JsonObject | null; pendingBatches?: number | JsonObject; batches?: JsonObject; watermarks?: JsonObject; scheduler?: JsonObject; }
interface MemoryData { compiled: MemoryCompiled; facts: MemoryFact[]; events: MemoryEvent[]; pinned: Array<{ id?: string; content?: string; createdAt?: string }>; health: MemoryHealth; }

const emptyData: MemoryData = { compiled: {}, facts: [], events: [], pinned: [], health: {} };
const text = (value: unknown, fallback = "—") => typeof value === "string" && value ? value : fallback;
const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const unwrap = <T,>(value: unknown, key: string): T => (value && typeof value === "object" && key in value ? (value as JsonObject)[key] : value) as T;

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

export function MemoryPage({ agentId }: MemoryPageProps) {
  const [data, setData] = useState<MemoryData>(emptyData);
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([]);  const [selectedAgent, setSelectedAgent] = useState(agentId ?? "");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (!selectedAgent) { setLoading(false); return; }
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const base = `/api/agents/${encodeURIComponent(selectedAgent)}/memory`;
      const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
      const [compiled, facts, events, pinned, health] = await Promise.all([
        getJson<MemoryCompiled>(`${base}/compiled`),
        getJson<MemoryFact[] | JsonObject>(`${base}/facts${search}`),
        getJson<MemoryEvent[] | JsonObject>(`${base}/events${search}`),
        getJson<Array<{ id?: string; content?: string; createdAt?: string }> | JsonObject>(`${base}/pinned`),
        getJson<MemoryHealth>(`${base}/health`),
      ]);
      setData({
        // compiled 响应为 {agentId, content, sections}，取 sections 四段
        compiled: unwrap<MemoryCompiled>(compiled, "sections") ?? {},
        facts: asArray<MemoryFact>(unwrap<unknown>(facts, "facts")),
        events: asArray<MemoryEvent>(unwrap<unknown>(events, "events")),
        pinned: asArray<{ id?: string; content?: string; createdAt?: string }>(unwrap<unknown>(pinned, "pinned")),
        health: unwrap<MemoryHealth>(health, "health") ?? {},
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "记忆加载失败"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [query, selectedAgent]);

  useEffect(() => { void getJson<Array<{ identity?: { id?: string; name?: string } }> | JsonObject>("/api/agents").then((value) => {
    // /api/agents 返回嵌套 AgentView（identity.id/name），需扁平化
    const list: Array<{ id: string; name?: string }> = asArray<{ identity?: { id?: string; name?: string } }>(unwrap<unknown>(value, "agents"))
      .flatMap((item) => item.identity?.id
        ? [{ id: item.identity.id, ...(item.identity.name !== undefined ? { name: item.identity.name } : {}) }]
        : []);
    setAgents(list); if (!selectedAgent && list[0]) setSelectedAgent(list[0].id);
  }).catch(() => { /* the page still explains how to retry */ }); }, [selectedAgent]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!selectedAgent) return undefined; const timer = window.setInterval(() => void load(true), 15000); return () => window.clearInterval(timer); }, [load, selectedAgent]);

  const filteredFacts = useMemo(() => query.trim() ? data.facts.filter((fact) => JSON.stringify(fact).toLowerCase().includes(query.toLowerCase())) : data.facts, [data.facts, query]);
  const filteredEvents = useMemo(() => query.trim() ? data.events.filter((event) => JSON.stringify(event).toLowerCase().includes(query.toLowerCase())) : data.events, [data.events, query]);
  const recallStatus = text(healthValue(data.health, "status"), "idle");
  const pending = typeof data.health.pendingBatches === "number" ? data.health.pendingBatches : text(data.health.pendingBatches ?? data.health.batches, "0");

  return <main className={styles.page}>
    <header className={styles.header}><Button variant="ghost" size="sm" onClick={navigateToWorkspace} aria-label="返回工作台"><ArrowLeft size={16} /> 返回</Button><div><h1><Brain size={22} /> 记忆</h1><p>只读查看上下文记忆、事实与回想健康状态</p></div><Button variant="ghost" size="sm" onClick={() => void load(true)} loading={refreshing} aria-label="刷新记忆"><RefreshCw size={16} /> 刷新</Button></header>
    <div className={styles.toolbar}>
      {agents.length > 0 && <label className={styles.agent}>Agent<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name ?? agent.id}</option>)}</select></label>}
      <TextField value={query} onChange={setQuery} type="search" placeholder="搜索事实与事件…" aria-label="搜索记忆" />
    </div>
    {error && <div role="alert" className={styles.error}><CircleAlert size={17} /> {error}<Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button></div>}
    {!selectedAgent && !loading && <EmptyState title="还没有可查看的 Agent" description="选择一个 Agent 后，这里会显示它的只读记忆。" />}
    {loading ? <div className={styles.loading}><Spinner /> 正在加载记忆…</div> : selectedAgent && <>
      <section className={styles.healthGrid} aria-label="记忆健康状态"><Card><strong>RecallEpisode</strong><span className={styles.status}>{recallStatus}</span><small>{text(healthValue(data.health, "resultCount"), "0")} 个结果 · {text(healthValue(data.health, "layer"), "等待回想")}</small></Card><Card><strong>Pending batch</strong><span className={styles.status}>{pending}</span><small>封存队列状态</small></Card><Card><strong>自动刷新</strong><span className={styles.status}>每 15 秒</span><small>记忆更新后保持最新</small></Card></section>
      <section><div className={styles.sectionTitle}><h2>编译记忆</h2><span>四段上下文制品</span></div><div className={styles.compiledGrid}>{([['today','今天'],['week','本周'],['longterm','长期'],['facts','重要事实']] as const).map(([key, label]) => <Card as="article" key={key}><h3>{label}</h3>{text(data.compiled[key], "暂无内容") !== "暂无内容" ? <pre>{data.compiled[key]}</pre> : <p className={styles.muted}>暂无内容</p>}</Card>)}</div></section>
      <section className={styles.columns}><Card as="section"><div className={styles.cardTitle}><h2>Pinned memories</h2><span>{data.pinned.length}</span></div>{data.pinned.length ? <ul>{data.pinned.map((item) => <li key={item.id ?? item.content}><Sparkles size={14} /><span>{text(item.content)}</span></li>)}</ul> : <p className={styles.muted}>暂无置顶记忆</p>}</Card><Card as="section"><div className={styles.cardTitle}><h2>已审批事实</h2><span>{filteredFacts.length}</span></div>{filteredFacts.length ? <ul>{filteredFacts.map((fact) => <li key={String(fact.id ?? fact.fact)}><strong>{text(fact.fact)}</strong><small>{fact.tags?.join(" · ") ?? ""}{fact.factTime ? ` · ${formatDate(fact.factTime)}` : ""}</small></li>)}</ul> : <p className={styles.muted}>暂无已审批事实</p>}</Card></section>
      <Card as="section"><div className={styles.cardTitle}><h2>事件时间线</h2><span>{filteredEvents.length}</span></div>{filteredEvents.length ? <ol className={styles.timeline}>{filteredEvents.map((event) => <li key={event.id ?? `${event.startedAt}-${event.summary}`}><time>{formatDate(event.startedAt ?? event.date)}</time><div><strong>{text(event.summary, "未命名事件")}</strong><small>{event.topics?.join(" · ") ?? ""}{event.sessionId ? ` · Session ${event.sessionId}` : ""}</small></div></li>)}</ol> : <p className={styles.muted}>暂无匹配事件</p>}</Card>
    </>}
  </main>;
}

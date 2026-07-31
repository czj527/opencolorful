# Phase 10：记忆系统底座 - openhanako 传送带、主动回想与封存队列

**状态：规划中** | 分支：`phase-10-memory`
**基线：** `main`（Phase 9 验收点之后）
**架构权威：** [docs/memory-architecture.md](../docs/memory-architecture.md)
**实现参考：** `<local-workspace>\references\openhanako\lib\memory\`（借机制，不抄代码）

---

## 一、目标

Phase 10 只建立可靠的记忆底座和两条通道的边界：

1. 以 openhanako 为主干实现 `today.md`、`week.md`、`longterm.md`、`facts.md`、`memory.md` 四段上下文记忆，增量编译并自动注入下一轮 system prompt。
2. 建立按 Session/branch revision 的 rolling summary、事件索引、FTS5+CJK 检索和 `search_memory` 只读回想入口。
3. 记录 recall ledger、RecallEpisode、`memory_journal`（追加式记忆意志）和 `sealed_memory_batch`，为 Phase 10.5 的记忆 Agent 提供输入，但不在对话路径修改长期记忆强度。
4. 进程重启、LLM 不可用、Session 归档和未绑定会话都拥有明确的降级行为。

### 用户可感知变化

- 绑定 Agent 的新会话能自动看到最近的 today/week/longterm/facts 记忆。
- Agent 在被问到过去的决定、偏好或项目时，可以调用 `search_memory` 主动回想，并显示“正在回想”状态。
- `/memory` 页面可以只读查看四段记忆、事件时间线和已审批事实。
- Session 结束后会封存长期整理批次，但不会阻塞会话关闭。

### 明确不做

- 记忆 Agent 的事实提取、强度变更、合并、冲突裁决、永久晋升和认知遗忘（Phase 10.5）。
- retention/activation 强度计算、短期/中期/永久晋升和强度图 UI（Phase 10.5）。
- 主 Agent 直接写入或修改长期记忆；`remember/forget/pin` 只形成待处理 `memory_journal` intent。
- 向量检索、梦境/三阶段 dreaming、技能系统和多 Agent 共享记忆。

---

## 二、通道边界

```text
PI JSONL（唯一原始经历）
  ├─→ 上下文记忆通道：rolling summary → today/week/longterm/facts.md → memory.md
  │                                           → 自动注入下一轮
  └─→ 长期记忆输入通道：事件索引 + recall ledger + sealed_memory_batch
                                              → Phase 10.5 记忆 Agent
```

Markdown 是可重建的上下文制品；`memory_facts` 是长期记忆表，但 Phase 10 只提供 schema 和只读检索，不由主 Agent 直接写入。长期记忆被回想不会自动写回 Markdown，Markdown 的滚动也不会直接改变长期记忆强度。

> **预期行为说明**：Phase 10 没有任何角色向 `memory_facts` 写入（事实提取从 Phase 10.5 的记忆 Agent 开始）——facts 表在 Phase 10 为空属预期，`search_memory` 的 facts 层返回空**不是 bug**；md 通道的 `facts.md` 由 compileFacts 正常维护，不受影响。

---

## 三、数据模型（SQLite migration v6）

以下表属于 Phase 10 底座；长期记忆的实际内容和强度由 Phase 10.5 审批后写入。

```sql
CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  branch_revision TEXT NOT NULL DEFAULT '',
  source_start_entry TEXT,
  source_end_entry TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_summaries_agent ON session_summaries(agent_id);

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_revision TEXT NOT NULL DEFAULT '',
  source_start_entry TEXT,
  source_end_entry TEXT,
  date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','forgotten','suppressed')),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, branch_revision, source_start_entry, source_end_entry)
);
CREATE INDEX idx_events_agent_date ON memory_events(agent_id, date);
CREATE INDEX idx_events_session ON memory_events(session_id);

CREATE VIRTUAL TABLE memory_events_fts USING fts5(
  summary, topics, search_text,
  content=memory_events, content_rowid=rowid, tokenize='unicode61'
);
-- insert/delete/update 三向触发器与 openhanako fact-store 同模式。

CREATE TABLE memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  fact_time TEXT,
  source TEXT NOT NULL DEFAULT 'agent_approved'
    CHECK (source IN ('agent_proposed','agent_approved','user_intent')),
  source_refs TEXT NOT NULL DEFAULT '[]',
  retention_strength INTEGER NOT NULL DEFAULT 0
    CHECK (retention_strength BETWEEN 0 AND 100),
  activation_strength INTEGER NOT NULL DEFAULT 0
    CHECK (activation_strength BETWEEN 0 AND 100),
  confidence REAL NOT NULL DEFAULT 0
    CHECK (confidence BETWEEN 0 AND 1),
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','forgotten','superseded','suppressed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_agent ON memory_facts(agent_id);
CREATE INDEX idx_facts_time ON memory_facts(fact_time);

CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
  fact, search_text, content=memory_facts, content_rowid=id, tokenize='unicode61'
);
-- insert/delete/update 三向触发器。

CREATE TABLE memory_recalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  recall_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session')),
  target_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('facts','events','source')),
  source_type TEXT NOT NULL DEFAULT 'memory_recall',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_recalls_agent ON memory_recalls(agent_id, created_at);

CREATE TABLE memory_recall_episodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','layer_changed','completed','empty','failed','cancelled')),
  result_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE memory_journal (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','main_agent','memory_agent','system')),
  intent_type TEXT NOT NULL CHECK (intent_type IN ('remember','forget','pin','unpin','supersede','merge','suppress','restore')),
  target_type TEXT NOT NULL CHECK (target_type IN ('fact','event','session','memory')),
  target_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','applied','revoked')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_memory_journal_agent_status ON memory_journal(agent_id, status, created_at);

CREATE TABLE memory_batches (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision_json TEXT NOT NULL DEFAULT '{}',
  source_start_entry TEXT,
  source_end_entry TEXT,
  status TEXT NOT NULL DEFAULT 'sealed'
    CHECK (status IN ('provisional','sealed','processing','applied','deferred','failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_batches_agent_status ON memory_batches(agent_id, status, created_at);

CREATE TABLE memory_daily_state (
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  step TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, date, step)
);

CREATE TABLE pinned_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pinned_agent ON pinned_memories(agent_id);
```

`memory_journal` 是记忆意志和 suppression 的追加式权威。`memory rebuild` 必须同时读取 JSONL 和 journal，否则 forget/delete 后会复活。`memory_daily_state` 是每日 Markdown 编译断点的唯一权威，不再同时维护同语义的 `daily-state.json`。

### Agent memory 目录

```text
agents/<id>/memory/
├── memory.md                 # 四段拼接成品，自动注入
├── today.md                  # 今天
├── week.md                   # 最近 6 天 daily 拼接
├── longterm.md               # 上下文中的长期背景摘要
├── facts.md                  # 上下文中的重要事实摘要
├── daily/YYYY-MM-DD.md       # 日记
└── state/                    # 编译水位线、reset marker；不存长期事实权威
```

---

## 四、MemoryTicker 与时间安排

| 触发 | 动作 | 是否修改长期强度 |
|---|---|---|
| 每 10 轮 | rolling summary → compileToday → assemble；下一轮使用新 revision | 否 |
| Session 结束/归档 | 补 rolling summary，创建 `sealed_memory_batch`，fire-and-forget | 否 |
| 分支变化 | 按 branch revision 重新生成摘要/事件索引，旧派生记录按 journal 过滤 | 否 |
| 跨日 | S0-S4：daily、today、week、longterm、facts、assemble | 否 |
| 启动 | 按 dirty watermark 恢复摘要、Markdown 和 pending batch | 否 |
| 手动 flush | 封存或处理 pending batch，但不绕过 MemoryPolicy | 否 |

约束：每 Agent 串行队列；异步任务不阻塞对话；LLM 失败使用上一版并积压水位线。Phase 10 不运行深度长期整理，不改变 `retention_strength`。

### 四段传送带

保持 openhanako 顺序：

```text
S0 compileDaily → S1 compileToday → S2 rollDailyWindow
→ S3 compileFacts → S4 assemble week + memory.md → publish next revision
```

`week.md` 由 daily 文件纯文件拼接；四段 Markdown 的“实时”含义是新 revision 完成后从下一轮生效，不要求每轮完整重写全部文件。

---

## 五、rolling summary 与事件索引

- JSONL 增量读取必须保存 PI entry 身份、`branch_revision` 和 cursor；不要以行号作为稳定身份。
- summary 格式必须包含 `### 重要事实` 与 `### 时间线`；失败时修复一次，仍失败则不推进 cursor。
- 事件索引复用时间线节文本；统计字段和 topics 规则提取，不额外调用 LLM；LLM 不可用时仍可落 deterministic stub。
- 同一 `(session_id, branch_revision, source_start_entry, source_end_entry)` 批次幂等。
- 回想结果、注入结果和 Agent 复述必须带 `sourceType`，不能成为新的独立事实证据。

---

## 六、主动回想工具与状态

主 Agent 默认只使用一个工具：

```text
search_memory(query, depth?: "quick" | "deep" | "source", timeRange?, limit?)
```

内部路径：`facts → events → source session`。`search_events` 和 `recall_session` 是服务端内部实现，**不注册给主 Agent**（仅供 search_memory 内部下钻与后续记忆 Agent 使用）。每次多层调用聚合成一个 `RecallEpisode`，广播：

```text
memory.recall.started
memory.recall.layer_changed
memory.recall.completed | memory.recall.empty | memory.recall.failed | memory.recall.cancelled
```

“没有找到相关记忆”与“回想系统失败”是不同结果。UI 状态与联网搜索同级，显示“正在努力回想 / 正顺着往事继续寻找 / 想起来了”。回想只写 `memory_recalls`，不直接写 `memory_facts`，不改变 retention strength。

---

## 七、工具、API 与只读页面

### 工具

| 工具 | 权限 | 说明 |
|---|---|---|
| `search_memory` | 主 Agent 只读 | 长期记忆统一入口，返回 provenance/confidence/strengthTier |
| `search_events` | 内部下钻 | 按日期和主题查事件 |
| `recall_session` | PathGuard 只读 | 读取受限 JSONL entry 段 |
| `remember` / `forget` / `pin_memory` | intent-only | 只追加 `memory_journal`，不改长期库 |

> **pin 的落地**：pin/unpin 属 Markdown 通道（低风险），平台**即时应用**到 `pinned_memories` 表并同步追加 journal 留痕，不等审批窗口；remember/forget 的长期库变更才等 Phase 10.5 审批。

### 注入（随 T6 落地）

- 顺序：底色 → 记忆使用规则 → `# Pinned Memories`（独立保底预算）→ `# Memory`（memory.md 四段）
- 整块 ≤2500 字符，超限按 今天 > 重要事实 > Pinned > 本周 > 长期 截断
- 注入前逐段威胁扫描（命中替换 `[BLOCKED]`）；摘要/事实落盘前 PII 脱敏
- 热更新：assemble 后新 revision 从下一轮生效

### HTTP API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/agents/:id/memory/compiled` | memory.md 四段内容 |
| GET | `/api/agents/:id/memory/facts?query=&tags=` | 已审批事实只读列表/搜索 |
| GET | `/api/agents/:id/memory/events?from=&to=&query=` | 事件时间线 |
| GET | `/api/agents/:id/memory/pinned` | Markdown 通道置顶只读查看 |
| POST | `/api/agents/:id/memory/flush` | 手动封存/处理 pending batch（仍经策略审批） |
| GET | `/api/agents/:id/memory/health` | 水位线、断点、pending batch 和回想状态 |

新增 SSE：`memory.updated`、`memory.recall.*`。同步 `web/src/lib/sse-client.ts` 的 `KNOWN_EVENT_TYPES`。

### `/memory` 只读页

- 四段记忆卡片（今天/本周/长期/重要事实）和 Markdown Pinned；
- 已审批事实列表、事件时间线、来源 Session 链接和搜索；
- RecallEpisode 状态和 pending batch 健康状态；
- Phase 10 不做长期事实编辑和强度编辑，编辑留 Phase 10.5+。

---

## 八、任务拆分

```text
T1 契约 + migration v6（主 Agent 串行）
   memory.ts、RecallEpisode、memory_journal、memory_batches、CJK n-gram、schema 单测
   ├─→ T2 存储层：summary/event/fact/recall/journal/batch/daily/pinned stores
   ├─→ T3 rolling summary + event indexer（branch cursor、幂等、deterministic fallback；
   │     **先写 PI 分支集成测试验证 entry/revision 语义，再冻结 cursor 契约**）
   │     └─→ T4 openhanako 编译流水线（today/daily/week/longterm/facts/assemble）
   ├─→ T5 MemoryTicker + Session 生命周期 + sealed batch + dirty recovery（主 Agent）
   ├─→ T6 search_memory + RecallEpisode + intent-only 工具 + 注入（依赖 T2）
   ├─→ T7 HTTP API + SSE（依赖 T6）
   └─→ T8 `/memory` 只读页（依赖 T7）
T9 质量门 + browser-use 验收（主 Agent）
```

测试：`tests/unit/{cjk-ngram,summary-format,memory-journal}.test.ts`、`tests/integration/{memory-ticker,memory-recall,memory-recovery,memory-api,memory-injection}.test.ts`。全部 faux provider + 临时 `OPENCOLORFUL_HOME`，禁止真实网络。

---

## 九、质量门

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test
# browser-use：四段记忆注入、search_memory 回想状态、sealed batch 和 /memory 页
```

---

## 十、验收标准

- [ ] v6 migration 幂等；FTS5 触发器同步；`memory_journal` 和 suppression 参与 rebuild；
- [ ] 绑定 Agent 每 10 轮生成 rolling summary，格式校验/修复和 branch cursor 生效；
- [ ] 四段 Markdown 按 openhanako 传送带编译；新 revision 从下一轮生效；失败继续上一版；
- [ ] 事件索引同一 source batch 幂等，LLM 不可用时 deterministic stub 仍可检索；
- [ ] `search_memory` 只读入口可用，facts → events → source 下钻聚合成 RecallEpisode；
- [ ] `memory.recall.*` 事件支持 started/layer_changed/completed/empty/failed/cancelled 并可 Replay；
- [ ] recall ledger、`memory_journal`、`sealed_memory_batch` 有写入记录；主 Agent 没有长期库写权限；
- [ ] 注入前威胁扫描、落盘前 PII 脱敏、超预算按优先级截断（Pinned 独立保底）生效；
- [ ] 未绑定 Session 不产生 Agent 记忆；Agent A 无法检索 Agent B；
- [ ] 中文混排和中文单字查询可用（单字安全 LIKE 降级）；
- [ ] 启动按 dirty watermark 恢复摘要、Markdown 和 pending batch；
- [ ] `/memory` 只读页面展示四段/事实/事件/回想状态并自动刷新；
- [ ] 全部质量门和 browser-use 验收通过。

---

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 成本或不可用 | 增量水位线、上一版制品、deterministic event stub、pending batch 重试 |
| Markdown 与长期库互相污染 | 明确两条通道；sourceType；长期库只读回想；不从 recall/injection 提取新事实 |
| forget/rebuild 复活 | `memory_journal` append-only suppression；rebuild 同时读取 JSONL+journal |
| PI 分支 cursor 差异 | entry ID + branch revision；先写分支集成测试 |
| 回想状态丢失 | RecallEpisode + SSE replay + durable recall ledger |
| 后台任务阻塞对话 | Session 封存和所有整理任务 fire-and-forget；per-agent 串行队列 |

---

## 实施记录

（实施中回填）

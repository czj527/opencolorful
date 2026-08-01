# Phase 10：记忆系统底座 - openhanako 传送带、主动回想与封存队列

**状态：已完成（2026-08-01）** | 分支：`phase-10-memory`
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
  session_id TEXT NOT NULL,
  branch_revision TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  source_start_entry TEXT,
  source_end_entry TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, branch_revision)
);
CREATE INDEX idx_summaries_agent ON session_summaries(agent_id);
CREATE INDEX idx_summaries_agent_branch ON session_summaries(agent_id, branch_revision);

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

CREATE TABLE memory_watermarks (
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('summary','events','markdown','batch')),
  branch_revision TEXT NOT NULL DEFAULT '',
  cursor_json TEXT NOT NULL DEFAULT '{}',
  dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, scope, branch_revision)
);

CREATE TABLE scheduler_state (
  agent_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','running','deferred','failed')),
  last_daily_date TEXT,
  last_daily_completed_at TEXT,
  last_weekly_completed_at TEXT,
  next_retry_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_recall_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL,
  recall_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  layer TEXT CHECK (layer IN ('facts','events','source')),
  status TEXT NOT NULL CHECK (status IN ('started','layer_changed','completed','empty','failed','cancelled')),
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_recall_events_episode ON memory_recall_events(episode_id, id);

CREATE TABLE pinned_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pinned_agent ON pinned_memories(agent_id);
```

`memory_journal` 是记忆意志和 suppression 的追加式权威。`memory rebuild` 必须同时读取 JSONL 和 journal，否则 forget/delete 后会复活。`memory_daily_state` 记录每日阶段完成点；`memory_watermarks` 记录 summary/events/Markdown/batch 的 branch-aware cursor 与 dirty 状态；`scheduler_state` 记录运行、延期、失败和下次重试。三者共同构成恢复契约，不再同时维护同语义的 `daily-state.json`。

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
| 启动 | 按 dirty watermark 恢复摘要、Markdown 和待处理 batch | 否 |
| 手动 flush（Phase 10） | 只封存、重建 Markdown 和事件索引；不运行记忆 Agent、不应用长期事实 proposal | 否 |

约束：每 Agent 串行队列；异步任务不阻塞对话；LLM 失败使用上一版并积压 dirty watermark。Phase 10 不运行深度长期整理，不改变 `retention_strength`。API/UI 中的“pending batch”是聚合称呼，具体持久化状态为 `provisional`、`sealed`、`processing`、`deferred` 或 `failed`；`applied` 表示已完成。

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

主 Agent 的长期记忆读取默认只有一个入口；记忆意图工具另行提供，但不授予长期库写权限：

```text
search_memory(query, depth?: "quick" | "deep" | "source", timeRange?, limit?)
```

内部路径：`facts → events → source session`。`search_events` 和 `recall_session` 是服务端内部实现，**不注册给主 Agent**（仅供 search_memory 内部下钻与后续记忆 Agent 使用）。每次多层调用聚合成一个 `RecallEpisode`，广播：

```text
memory.recall.started
memory.recall.layer_changed
memory.recall.completed | memory.recall.empty | memory.recall.failed | memory.recall.cancelled
```

“没有找到相关记忆”与“回想系统失败”是不同结果。UI 状态与联网搜索同级，显示“正在努力回想 / 正顺着往事继续寻找 / 想起来了”。回想写入 `memory_recalls` 和 `memory_recall_events`，不直接写 `memory_facts`，不改变 retention strength。

---

## 七、工具、API 与只读页面

### 工具

| 工具 | 权限 | 说明 |
|---|---|---|
| `search_memory` | 主 Agent 只读 | 长期记忆统一入口，返回 provenance/confidence/strengthTier |
| `search_events` | 内部下钻 | 按日期和主题查事件 |
| `recall_session` | PathGuard 只读 | 读取受限 JSONL entry 段 |
| `remember` / `forget` | intent-only | 只追加 `memory_journal`，不改长期库 |
| `pin_memory` / `unpin_memory` | 低风险即时应用 | 更新 Markdown 通道的 `pinned_memories`，并追加 journal 留痕 |

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
| POST | `/api/agents/:id/memory/flush` | 手动封存、重建 Markdown/事件索引；Phase 10 不应用长期事实 proposal |
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
- [ ] 分支摘要按 `(session_id, branch_revision)` 隔离；watermark/scheduler_state 可在中断后恢复；RecallEpisode 的 SSE 状态可从 `memory_recall_events` Replay；
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

### T1 契约 + migration v6（2026-07-31，主 Agent）

- 提交：`d8c6bd0` feat(memory): T1 契约 + migration v6（记忆系统底座）
- 前置：`b429f33` docs(memory): finalize Phase 10/10.5 review revisions（main）
- 交付：
  - `src/contracts/memory.ts`：RecallEpisode / memory_journal / memory_batches / 强度与状态枚举 / search_memory 与 remember/forget/pin/unpin 工具参数 TypeBox schema / MemoryUpdatedPayload、MemoryRecallPayload SSE 契约；`NON_EVIDENCE_SOURCE_TYPES` 防自我强化标记
  - `src/contracts/events.ts` + `web/src/lib/sse-client.ts`：注册 `memory.updated` 与 `memory.recall.started/layer_changed/completed/empty/failed/cancelled` 事件族
  - `src/storage/migrations.ts` v6：12 张记忆表 + `memory_events_fts`/`memory_facts_fts` 虚表 + 三向同步触发器（events 用 rowid、facts 用 id 作 content_rowid）
  - `src/storage/memory/cjk-ngram.ts`：NFKC 归一、CJK 2/3-gram、FTS 查询构建、单字 LIKE 降级（`ESCAPE '\'` 通配符转义）
  - `src/storage/database.ts`（连带修复）：迁移失败关闭句柄，消除 Windows 文件占用泄漏
- 测试：`tests/integration/memory-schema.test.ts`（10）、`tests/unit/cjk-ngram.test.ts`（20）、`tests/unit/memory-contracts.test.ts`（19）
- 验证证据：`npx tsc --noEmit` exit 0；`verify-pi-sdk-imports` exit 0；`npx vitest run` 47 文件 439 全过；`npm run test --workspace=web` 28 文件 326 全过
- 测试中发现并修正：FTS OR 查询的 n-gram 部分重叠语义（更新同步断言改用完全不重叠词项）；openhanako base+gram 结构的去重语义（断言改为跨 run gram 去重）
- 已知偏差：无

### T2 存储层（2026-08-01，子 Agent 实现 + 主 Agent 审查）

- 提交：`9beb588` feat(memory): T2 存储层 stores
- 交付：`src/storage/memory/` 下 8 个 store（summary/event/fact/recall/journal/batch/recovery/pinned）；fact store 只读无写入方法；journal append-only + suppression 查询；batch pending 聚合排序；54 个集成测试
- 审查：tsc 0 / 54 测试全过 / 主 Agent 独立复核 diff 后提交

### T3 rolling summary + 事件索引（2026-08-01）

- 提交：`2c7021d`（共享件分支读取器）+ `ce5b737`（T3 本体）
- 关键前置：`tests/integration/memory-branch.test.ts` 用真实 SessionManager + branch() 分叉验证 entry/revision 语义，**cursor 契约据此冻结**：cursor = {lastEntryId}；分支变更 ⇔ entriesAfterEntry 返回 null；revision = 当前路径 id 序列 sha256 前 16 hex
- 交付：`pi-sdk/complete-text.ts`（completeSimple 工具型 LLM 适配）、summary-format/prompts、RollingSummaryService（全量/增量/分支三模式、repair once、失败不推进 cursor、degraded + dirty watermark、落盘前脱敏）、EventIndexer（零额外 LLM、确定性 id 幂等、deterministic stub）
- 测试：summary-format 16 + memory-summary 12 + branch 6
- 审查修正：未使用导入清理

### T4 openhanako 编译流水线（2026-08-01）

- 提交：`39b75e3` feat(memory): T4 四段 Markdown 编译传送带 S0-S4
- 交付：memory-files（04:00 逻辑日边界、atomicWrite）、compile-prompts、MemoryCompilePipeline（S0 daily → S1 today → S2 longterm fold → S3 facts → S4 assemble；daily_state 断点幂等续跑；LLM 失败保留上一版、markdown watermark dirty；week 纯文件拼接零 LLM；memory.md 四段标题固定 + 占位符；revision = sha256 前 12）
- 审查修正：S0/S1 的 session summaries 按日期过滤（today/yesterday 分别取对应日期的摘要）
- 测试：memory-files 2 + memory-compile 1

### T5 MemoryTicker + Session 生命周期 + sealed batch + dirty recovery（2026-08-01，主 Agent）

- 提交：`22ef498` feat(memory): T5 MemoryTicker 接入生产生命周期与恢复队列
- 交付：turn.completed 每 10 轮触发（turnsPerSummary 可配）、per-Agent 串行 promise tail 队列 + 去重、summary 成功后才封存确定性 batch（degraded/failed 不产假 batch）、idle gate 兜底 housekeeping、启动按 dirty watermark/pending batch 恢复、生产组合根 start/stop 接线
- 审查修正：EventIndexer deterministic stub 保留 events dirty（避免 LLM 恢复后不再整理）；degraded 摘要直接短路不封存
- 测试：memory-ticker 2（threshold 触发 + degraded 路径）

### T6 search_memory + RecallEpisode + intent 工具 + 注入（2026-08-01）

- 提交：`1563832` feat(memory): T6 search_memory + RecallEpisode + intent-only 工具 + 注入
- 交付：MemoryRecallService（facts→events→source 确定性下钻、RecallEpisode 生命周期、memory.recall.* SSE agent stream、每 hit 写 recall ledger、memory_recall_events 落库 Replay、source 层归属 + 路径 containment 校验）；5 个工具（search_memory/remember/forget/pin/unpin，global-Symbol 上下文 fail-closed；remember/forget 只追加 journal；pin/unpin 即时应用 + 留痕）；注入（规则→Pinned 独立保底→Memory 四段、8 条威胁扫描 [BLOCKED]、预算截断优先级、revision 参与重建比较实现下一轮生效）；MEMORY_TOOL_NAMES 不受 tool_mode 影响
- 审查修正：source 层 ledger 的 queryHash/sessionId 语义、empty reachedLayer 按实际下钻深度、注入预算完整计量（规则段/头部计入）、SessionRuntime onDispose 注销 memory context 防泄漏
- 测试：recall 11 + injection 11 + tools 9

### T7 只读 API + Agent SSE（2026-08-01）

- 提交：`163e5b8` feat(memory): T7 只读 API + Agent SSE 与 T8 memory 页面（与 T8 合并提交）
- 交付：`/api/agents/:id/memory/{compiled,facts,events,pinned,flush,health}`；Agent-scoped SSE `/api/agents/:id/events`（Replay + ownership 过滤）；SseClient 支持 agent stream
- 验收修正（`0659c80`）：compiled 返回四段 sections（复用注入解析器防契约漂移）

### T8 /memory 只读页（2026-08-01）

- 提交：`163e5b8`（与 T7 合并）+ `0659c80` 修复
- 交付：四段编译记忆卡片、Pinned、已审批事实、事件时间线、RecallEpisode/pending batch 健康卡片、搜索、加载/错误/空态、Agent 选择、15 秒自动刷新；Phase 10 无编辑入口
- 验收修正（`0659c80`）：/api/agents 返回嵌套 AgentView，页面扁平化为 {id,name}（修复选择器空选项与自动选中）；段解析器未知 ## 标题视为内容（week 段内 ## {date} 子标题不再清空当前段）
- 测试：MemoryPage 2（夹具对齐真实 API 形状）

### T9 质量门 + browser-use 验收（2026-08-01，主 Agent）

- 最终门（全部独立通过）：verify-pi-sdk-imports 0 / tsc --noEmit 0 / vitest 57 文件 564 全过 / web 29 文件 328 全过 / web:build 通过 / tsc -p tsconfig.build.json 0 / Playwright 41/41
- browser-use 实际验收：启动本地服务 → `/memory` 页 → Agent 选择器列出全部 Agent 并自动选中 → 健康卡片（RecallEpisode idle / pending batch 0 / 15 秒刷新）→ 选中播种 Agent 后四段正确渲染（今天/本周含 ## 日期子标题/长期/重要事实）→ API 全链路（compiled 四段、facts 空为 Phase 10 预期、events、pinned、health、flush 202 安全响应、跨 Agent 404）→ 截图留存
- 验收发现并修复 3 项真实缺陷（`0659c80`）：AgentView 扁平化、compiled sections 契约、week 子标题解析
- 结论：**Phase 10 验收通过（含评审修复轮后重验）**

### 评审修复轮（2026-08-01，P0 阻断 + 计划缺口，提交 `74eaf87`）

评审复现 P0：`MemoryEventPublisher` 每实例从 0 起计，却发布到共享 `agent:<agentId>` 流，连续两次回想产生 `[1,1]` 而非 `[1,2]`，破坏 Last-Event-ID 续传与 Replay。

- **P0 修复**：进程内按 streamId 共享的单调序号分配器（`agentStreamSequences`）；新增测试：连续两次回想 sequence 严格递增、并发两次（Promise.all）严格递增且无重复、中途游标 `getSince` 续传不重不漏（recall 13 测试全过）
- **归档封存钩子**：`SessionService.onArchive`（可选回调）→ `MemoryTicker.onSessionArchived` 立即创建高优先级（priority=1）sealed batch，落地计划「Session 结束/归档创建 sealed batch」；ticker 新增归档测试
- **ticker 驱动编译流水线**：摘要成功后 `compilePipeline.refreshToday`（S1+S4）——四段 Markdown 生产链路打通（此前 pipeline 无人驱动）；housekeeping 跨日执行 `runDaily`（scheduler_state.lastDailyDate 防重）
- **flush 落地**：组合根注入 `memoryFlushHook` → `requestFlush`（封存活跃会话 + 每日重建），生产路径不再是 202 占位；无钩子环境返回安全降级
- **生产 LLM 接线**：completeText 经 ModelService 首个已配置 Provider；opaque PiResolvedModel 在 pi-sdk 内收窄（`completeUtilityTextForResolved`）；无凭据抛错 → 记忆组件走 degraded 不阻塞对话
- 重跑质量门：vitest 57 文件 **567** 全过 / web 328 全过 / web:build / tsc / 构建 / 边界 0

### 已知未完成项（Phase 10 边界，记录在案）

- `flush` 在无组合根钩子环境（测试/嵌入式）仍为安全占位响应；生产路径已真实封存+重建
- batch 恢复无租约/attempt 计数（per-Agent 串行队列当前防重复；Phase 10.5 并行整理时需补原子 claim）
- 生产 ticker 的 completeText 固定取第一个已配置 Provider 的第一个模型，未做 per-Agent/per-Session 解析（Phase 10.5 §六 utility 模型链预留）
- `memory.updated` 事件类型已注册但尚无发布方（T4 assemble 返回 revision；SSE 广播留给 10.5）
- 事件索引 deterministic stub 保留 events dirty，LLM 可用后由 recovery 重新整理（预期行为）
- 评审方环境 Playwright CLI 不可用；本环境 Playwright 41/41 通过，browser-use 已用真实 Agent（新建 + 播种 memory.md）完成四段渲染与 API 全链路验收

# Phase 10：记忆系统底座 — openhanako 传送带 + 时间线深库 + 分层查询

**状态：规划中** | 分支：`phase-10-memory`
**基线：** `main`（Phase 9 验收点之后；**动手前先提交工作区未提交的沙箱改动**）
**架构权威：** [docs/memory-architecture.md](../docs/memory-architecture.md)（数据流/存储/注入契约以该文为准，本文是其实施计划）
**实现参考：** `<local-workspace>\references\openhanako\lib\memory\`（逐模块对应见 §4.10）

---

## 一、目标

让绑定 Agent 的会话首次拥有跨会话记忆：**今天/本周/长期/重要事实四段热记忆自动编译并注入上下文；全量会话按时间建事件索引；事实库可检索；agent 可用分层工具从事实下钻到事件、原文。**

### 用户可感知的变化

- 绑定 Agent 新开对话时，"记得"最近几天/本周做的事（memory.md 注入）
- Agent 能主动搜索"我们之前关于 X 讨论过什么"并下钻到具体会话原文
- 用户可以 pin 重要事项；Agent 可用 remember/forget 自主管理记忆
- `/memory` 页面只读查看 Agent 的四段记忆、事实列表、事件时间线并搜索
- 跨天后记忆自动整理（日记蒸馏、折叠归档），进程重启不断档

### 明确不做（Phase 10.5 及以后）

- ❌ 记忆 agent（专职加工 agent，10.5 接管深潜）
- ❌ 强度/权重评分、记忆强度图 UI（10.5 由评测数据裁决）
- ❌ 评测台（10.5）、向量检索（12+）、梦境巩固（12+）
- ❌ 多 Agent 共享/跨界记忆（默认严格 per-agent 隔离）

---

## 二、范围与现有基础

### 2.1 可复用基础

| 能力 | 位置 | 复用方式 |
|---|---|---|
| turn 边界事件 | `src/runtime/event-mapper.ts:30`（turn.completed） | ticker 触发钩子 |
| PI JSONL 会话与分支 | `src/pi-sdk/agent-session.ts` | 增量读取 + cursor（leafId/lineage） |
| SQLite 迁移模式 | `src/storage/migrations.ts`（当前 v5） | 新增 v6 |
| Agent 三文件目录 | `src/config/agent-store.ts:287`（agentDir） | 新增 `memory/` 子目录 |
| system prompt 注入点 | `src/server/routes/messages.ts:37`（buildSystemPrompt） | 追加记忆块 |
| LLM 调用 | `src/runtime/model-service.ts` | 摘要/编译用会话同 Provider 或配置 utility 模型 |
| 原子写/归一化降级 | `src/config/preferences-store.ts` 模式 | state 文件与 memory.md 写入 |
| 工具注册与权限 | `src/pi-sdk/agent-session.ts` 工具白名单 + `src/runtime/tool-policy.ts` | 记忆工具注册；recall_session 走 PathGuard 只读 |

### 2.2 缺口

无任何记忆基础设施（无摘要、无编译、无事实库、无记忆工具、无注入）。

---

## 三、数据模型（SQLite 迁移 v6 + agent memory 目录）

### 3.1 `metadata.sqlite` 新增表（migration v6）

```sql
-- 会话滚动摘要（每 session 一份，openhanako summaries/*.json 的表化）
CREATE TABLE session_summaries (
  session_id    TEXT PRIMARY KEY,
  agent_id      TEXT,                       -- NULL = 未绑定（不产生记忆，仅留底）
  summary       TEXT NOT NULL DEFAULT '',   -- 两节格式：### 重要事实 + ### 时间线
  message_count INTEGER NOT NULL DEFAULT 0,
  cursor_json   TEXT NOT NULL DEFAULT '{}', -- {coveredLeafId, lineageHash} 分支保护
  snapshot      TEXT NOT NULL DEFAULT '',   -- 上次深潜时快照（summary≠snapshot ⇒ 脏）
  snapshot_cursor_json TEXT NOT NULL DEFAULT '{}',
  source_start  TEXT, source_end TEXT,      -- 覆盖时间范围
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_summaries_agent ON session_summaries(agent_id);

-- 时间线事件索引（深层，rolling summary 副产品，零额外 LLM）
CREATE TABLE memory_events (
  id            TEXT PRIMARY KEY,           -- UUID
  agent_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  date          TEXT NOT NULL,              -- YYYY-MM-DD 分区键
  started_at    TEXT NOT NULL, ended_at TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',   -- 复用摘要"时间线"节文本
  topics        TEXT NOT NULL DEFAULT '[]', -- JSON，规则提取（工具名+关键词）
  search_text   TEXT NOT NULL DEFAULT '',   -- CJK 2/3-gram
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'  -- active | forgotten
    CHECK (status IN ('active','forgotten')),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_events_agent_date ON memory_events(agent_id, date);
CREATE INDEX idx_events_session ON memory_events(session_id);

CREATE VIRTUAL TABLE memory_events_fts USING fts5(
  summary, topics, search_text,
  content=memory_events, content_rowid=rowid, tokenize='unicode61'
);
-- 触发器：insert/delete/update 三向同步（照 openhanako fact-store.ts:140-151 模式）

-- 事实库（openhanako facts.db 移植 + provenance/有效期）
CREATE TABLE memory_facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  fact          TEXT NOT NULL,
  search_text   TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  fact_time     TEXT,                       -- 事实涉及的时间 YYYY-MM-DDTHH:MM
  source        TEXT NOT NULL DEFAULT 'extracted'
    CHECK (source IN ('extracted','remember','compiled')),
  source_refs   TEXT NOT NULL DEFAULT '[]', -- JSON: [{sessionId, eventId}] 溯源
  valid_until   TEXT,                       -- NULL=有效；旧识失效不删
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','forgotten','superseded')),
  session_id    TEXT,
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_agent ON memory_facts(agent_id);
CREATE INDEX idx_facts_time ON memory_facts(fact_time);

CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
  fact, search_text, content=memory_facts, content_rowid=id, tokenize='unicode61'
);
-- 同模式三触发器

-- 检索命中记录（Phase 10 只写不读，为 10.5 评测/梦境备数据）
CREATE TABLE memory_recalls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('fact','event')),
  target_id   TEXT NOT NULL,
  query_hash  TEXT NOT NULL,
  layer       TEXT NOT NULL,                -- L1 | L2
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_recalls_agent ON memory_recalls(agent_id, created_at);

-- 每日任务断点
CREATE TABLE memory_daily_state (
  agent_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  step        TEXT NOT NULL,                -- S0..S5
  done_at     TEXT NOT NULL,
  PRIMARY KEY (agent_id, date, step)
);

-- 置顶
CREATE TABLE pinned_memories (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_pinned_agent ON pinned_memories(agent_id);
```

### 3.2 `agents/<id>/memory/` 目录（热层制品，可读可重建）

```
memory/
├── memory.md        # 四段成品（## 重要事实 / ## 今天 / ## 本周早些时候 / ## 长期情况）
├── today.md         # 今天（3-5 条粗事件，时间锚点，跨日重置）
├── daily/YYYY-MM-DD.md   # 日记（2-3 句，≤60字）
├── week.md          # 本周早些时候（daily 最近 6 天拼接，≤1200 字符，零 LLM）
├── longterm.md      # 长期情况（≤400 字，LLM 折叠）
├── facts.md         # 重要事实（≤200 字，与摘要事实节双向往复）
└── state/
    ├── today-state.json        # compileToday 水位线
    ├── facts-state.json        # compileFacts 水位线
    └── reset.json              # 编译重置标记
```

### 3.3 契约类型（`src/contracts/memory.ts`，TypeBox）

`RollingSummary`（facts/timeline 两节 + cursor）、`MemoryEvent`、`MemoryFact`、`MemoryLayer`（`"L0"|"L1"|"L2"|"L3"`）、`MemorySearchQuery`、`SearchFactsParams`、`SearchEventsParams`、`RecallSessionParams`、`RememberParams`、`ForgetParams`、`PinParams`、`MemoryConfig`（默认值见 §4.9）。所有跨进程输入走 TypeBox 校验。

---

## 四、核心机制设计

### 4.1 MemoryTicker（`src/memory/memory-ticker.ts`）

照 openhanako `memory-ticker.ts` 的触发模型，适配我们的事件钩子：

| 触发 | 来源 | 动作 |
|---|---|---|
| 每 10 轮 | session-runtime turn 完成回调 | rolling summary → compileToday → assemble → 热刷新 |
| 会话结束/归档 | session-service 生命周期 | 补 rolling summary（fire-and-forget） |
| 跨日 | notifyTurn 内检测 + 1h 兜底 timer | 每日任务 S0-S5 |
| 启动 | server 启动 | 恢复扫描 24h 内有更新的绑定会话，补摘要 |
| 手动 | HTTP API `POST /api/agents/:id/memory/flush` | 立即执行一轮 |

约束：**per-agent 串行队列**（同 agent 记忆任务排队，防并发写）；异步不阻塞对话路径；LLM 失败按 §4.8 降级积压。

### 4.2 Rolling Summary（`src/memory/rolling-summary.ts` + `summary-format.ts`）

- 格式契约（照 `rolling-summary-format.ts` 单一源头）：输出必须含 `### 重要事实` 与 `### 时间线` 两节；标题文本/校验/提取/修复 prompt 全部集中在 `summary-format.ts`
- 流程：读 JSONL 增量（cursor 起）→ LLM 生成 → `validateSummaryFormat()` 校验 → 失败则 LLM 修复 1 次 → 落 `session_summaries`
- **分支保护**：cursor 记录 `{coveredLeafId, lineageHash}`，分支回退/retry 后旧摘要不参与深潜（openhanako branch cursor 同款）
- **PII**：落库前 `scrubPII()`（新 util，规则：API Key/令牌/邮箱/手机号模式）
- 每会话保留一份，覆盖式更新（新摘要替代旧摘要，事实节双向往复见 §4.4）

### 4.3 事件索引（`src/memory/event-indexer.ts`）

rolling summary 落库后顺手生成：**摘要"时间线"节文本 → memory_events.summary**，统计字段（message_count/tool_calls/duration）从 JSONL 增量段统计，topics 用规则提取（工具名 + 高频关键词），search_text 走 §4.6。**零额外 LLM 调用**。同一批次重复生成时按 `(session_id, cursor)` 幂等替换。

### 4.4 编译流水线（`src/memory/compile.ts` + `prompts/compile.ts`）

每日任务（`_doDaily()`，S0-S5，`memory_daily_state` 断点续跑）：

| 步骤 | 函数 | 内容 | 上限 |
|---|---|---|---|
| S0 | compileDaily | 昨天 today.md → LLM 蒸馏 → `daily/{date}.md` | 2-3 句 ≤60 字 |
| S1 | compileToday | today.md 新日重置开局 | 3-5 条 |
| S2 | rollDailyWindow | 滚出 6 日窗口的日记 → LLM 折叠进 longterm.md → 删源文件 | ≤400 字 |
| S3 | compileFacts | 摘要事实节 ↔ facts.md 双向往复（增量水位线） | ≤200 字 |
| S4 | assemble | 拼 memory.md（空段占位符）→ 触发热刷新 + `memory.updated` 事件 | — |
| S5 | deepDive | 脏摘要（summary≠snapshot）→ 事件索引补齐 + LLM 事实提取 → memory_facts | — |

对话中每 10 轮跑的是轻量版：rolling summary → compileToday → assemble（S5 深潜只在每日任务跑）。

### 4.5 检索（`src/memory/memory-search.ts`）

- **search_facts**：tags 精确匹配（json_each）优先 → 结果 <3 条 FTS5 兜底 → FTS 语法错误 LIKE 降级；默认排除 forgotten/superseded
- **search_events**：`agent_id + status='active'` 过滤，日期范围 + FTS5；按 date 倒序；`include_dormant` 参数预留（P10 恒 false）
- **recall_session**：经 PathGuard 只读校验后读 JSONL 指定行段；单次 ≤200 行 / ≤16K 字符；返回带行号
- 命中即写 `memory_recalls`（异步，不阻塞返回）

### 4.6 CJK 检索（`src/memory/cjk-ngram.ts`）

对中文/日文/韩文连续片段生成 2-gram + 3-gram，写入与查询两侧同规则处理（照 openhanako `fact-store.ts` search_text 方案）。单测覆盖：纯中文、中英混排、纯英文。

### 4.7 注入契约（修改 `src/server/routes/messages.ts` buildSystemPrompt）

顺序：底色 → **记忆使用规则**（固定文本，含下钻指引）→ `# Pinned Memories` → `# Memory`（memory.md）。约束：

- 整块 ≤2500 字符，超限按 今天 > 重要事实 > Pinned > 本周 > 长期 截断
- 注入前 `scanForThreats()` 逐段扫描，命中替换 `[BLOCKED]`
- 热刷新：assemble 后更新 system prompt（10 轮一批天然限频）
- 仅绑定 Agent 且记忆开启时注入；未绑定会话不注入

### 4.8 LLM 降级

| 环节失败 | 行为 |
|---|---|
| rolling summary LLM 失败 | 积压水位线不推进，下轮重试（≤3 次后跳过该批，记入健康状态） |
| compileToday/compileDaily/facts 失败 | 断点停留该步骤，下次每日任务续跑；memory.md 保持上一版 |
| 深潜提取失败 | snapshot 不推进，次日重试 |
| 事件索引 | **零 LLM**，永远可用 |

### 4.9 默认配置（`src/config/memory-config.ts`，常量进配置不进代码散点）

`turnsPerSummary=10`、`weekWindowDays=6`、`limits{today:5条, daily:60字, week:1200字符, longterm:400字, facts:200字}`、`injectBudgetChars=2500`、`recoveryWindowHours=24`、`recallSessionMaxLines=200`。

### 4.10 与 openhanako 模块对应表（实现时对照阅读）

| 我们的文件 | openhanako 参考 |
|---|---|
| `src/memory/memory-ticker.ts` | `lib/memory/memory-ticker.ts` |
| `src/memory/rolling-summary.ts` | `lib/memory/session-summary.ts` |
| `src/memory/summary-format.ts` | `lib/memory/rolling-summary-format.ts` |
| `src/memory/compile.ts` + `prompts/compile.ts` | `lib/memory/compile.ts` + `prompts/compile.ts` |
| `src/memory/deep-dive.ts` | `lib/memory/deep-memory.ts` |
| `src/memory/fact-store.ts` | `lib/memory/fact-store.ts` |
| `src/memory/memory-search.ts` | `lib/memory/memory-search.ts` |
| `src/memory/pinned-store.ts` | `lib/memory/pinned-memory-store.ts` |
| `src/memory/cjk-ngram.ts` | `lib/memory/fact-store.ts` 内 search_text 逻辑 |

> 注意：openhanako 是 JS+自家 harness，我们是 TS strict + PI 适配层——**抄机制不抄代码**，prompt 模板可移植后按我们的格式契约调整。

---

## 五、记忆工具（agent 可调用，经 PI 适配层注册）

| 工具 | 参数要点 | 说明 |
|---|---|---|
| `search_facts` | query?, tags?, date_from?, date_to?, limit=10 | 事实第一站 |
| `search_events` | query?, date_from?, date_to?, limit=10 | 时间叙事下钻 |
| `recall_session` | session_id, from_line?, to_line? | 原文回溯（只读，PathGuard 校验） |
| `remember` | content, tags? | 记一条事实（source='remember'） |
| `forget` | target('fact'/'event'), id, reason? | 放逐，留痕可审计 |
| `pin_memory` / `unpin_memory` | content / id 或 keyword | 置顶管理 |

返回统一带 provenance（date/session_id/event_id）与 `hint`（如"结果可能不完整，可用 search_events 按日期下钻"）。工具描述文本中写明分层使用顺序。

---

## 六、HTTP API（`src/server/routes/memory.ts`）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/agents/:id/memory/compiled` | memory.md 四段内容 |
| GET | `/api/agents/:id/memory/facts?query=&tags=` | 事实列表/搜索 |
| GET | `/api/agents/:id/memory/events?from=&to=&query=` | 事件时间线 |
| GET | `/api/agents/:id/memory/pinned` / POST / DELETE `:pinId` | 置顶管理 |
| POST | `/api/agents/:id/memory/flush` | 手动触发一轮整理 |
| GET | `/api/agents/:id/memory/health` | 水位线/断点/积压状态 |

新增 SSE 事件 `memory.updated`（assemble 后广播）→ 同步 `web/src/lib/sse-client.ts` 的 `KNOWN_EVENT_TYPES`。

---

## 七、Web 只读页 `/memory`（`web/src/pages/MemoryPage.tsx`）

- 四段记忆卡片展示（今天/本周/长期/重要事实）+ Pinned
- 事实列表（标签/时间/来源会话链接）+ 搜索框
- 事件时间线（按日分组，简列表，点击展开摘要）
- 收到 `memory.updated` 自动刷新；从 Agent 设置页入口跳转
- 复用 Phase 7 UI 原语与 tokens；不做编辑（编辑留 10.5+）

---

## 八、任务拆分（依赖与归属）

```
T1 契约+迁移（主 Agent 串行先行）
   src/contracts/memory.ts、migrations v6、cjk-ngram util + 单测
   ├─→ T2 存储层（子 Agent A）：session-summaries/event/fact/pinned/recall/daily-state
   │     六个 store + FTS 触发器 + 单测
   ├─→ T3 摘要与事件索引（子 Agent B，依赖 T1/T2）：summary-format、
   │     rolling-summary、event-indexer + 单测（faux provider）
   │     ├─→ T4 编译流水线（子 Agent B）：compile.ts + prompts + memory 目录管理
   │     │     + 断点续跑 + 单测
   │     ├─→ T5 Ticker 与生命周期集成（主 Agent）：memory-ticker、
   │     │     session-runtime 钩子、启动恢复扫描、降级逻辑 + 集成测试
   │     ├─→ T6 工具与注入（子 Agent C，依赖 T2）：六个记忆工具注册、
   │     │     buildSystemPrompt 注入、预算/威胁扫描 + 集成测试
   │     └─→ T7 HTTP API（子 Agent C）：routes/memory.ts + SSE 事件 + 集成测试
   └─→ T8 Web /memory 页（子 Agent D，依赖 T7 契约）：页面 + 单测
T9 质量门 + browser-use 验收（主 Agent）
```

并行规则：T3/T4 与 T6 不共享文件可并行；T8 只依赖 API 契约。子 Agent 报告不作验收证据，主 Agent 独立复核 + 重跑质量门。

**测试文件**：`tests/unit/{cjk-ngram,summary-format,compile,event-indexer}.test.ts`、`tests/integration/{memory-ticker,memory-tools,memory-api,memory-injection,memory-recovery}.test.ts`。全部 faux provider + 临时 `OPENCOLORFUL_HOME`，禁止真实网络。

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
# browser-use：/memory 页 + 绑定 Agent 对话后记忆注入 + 工具调用验收
```

---

## 十、验收标准

- [ ] v6 迁移幂等，FTS5 触发器同步正确
- [ ] 绑定 Agent 会话满 10 轮自动生成 rolling summary，格式校验/修复生效
- [ ] 事件索引零 LLM 生成，含 CJK search_text；同一批次幂等
- [ ] 跨日触发每日任务 S0-S5，断点续跑可恢复；week 装配零 LLM
- [ ] memory.md 四段正确拼合并注入 system prompt（含规则/Pinned），预算截断与威胁扫描生效
- [ ] search_facts（tags→FTS→LIKE）/ search_events / recall_session 三层检索可用，provenance 完整；中文单字可检索
- [ ] remember/forget/pin 生效且留痕；forget 后默认检索不可见
- [ ] per-agent 隔离：Agent A 检索不到 Agent B 的事实/事件；未绑定会话无记忆产物
- [ ] LLM 失败时按 §4.8 降级，系统不停摆；启动恢复扫描补摘要
- [ ] `/memory` 页展示四段/事实/事件并可搜索；`memory.updated` 自动刷新
- [ ] memory_recalls 有写入记录
- [ ] 全部质量门通过；browser-use 验收通过

---

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 成本（摘要+编译多点调用） | 增量水位线 + 每日任务合并 + 事件索引零 LLM；后续支持 utility 小模型 |
| 抄错 openhanako 机制 | §4.10 对照表逐模块阅读；关键行为（水位线/断点/格式契约）先写测试 |
| PI 分支 cursor 语义差异 | T3 先用集成测试摸清 PI leafId/lineage 行为再定 cursor 结构 |
| 热刷新导致前缀缓存失效 | 10 轮一批限频；10.5 评测冻结 vs 热更新后定默认 |
| 中文检索质量 | CJK n-gram + 单测覆盖混排场景 |

---

## 实施记录

（实施中回填）

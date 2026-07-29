# Phase 10：记忆系统 — 事件基线 + 强度加权 + 分层检索

**状态：规划中** | 分支：`phase-10-memory`
**基线：** `main`（Phase 9 验收点，`a5c9190`）
**参考：** openhanako conveyor belt + FTS5 facts.db（主参考）；openclaw 六信号评分引擎；hermes 原子 I/O + 批处理操作

---

## 一、核心设计理念

记忆系统不是把对话压缩成摘要——而是**以完整事件时间线为基线，每条事件拥有独立的存在感和动态强度，检索时按深度分层访问**。

| 理念 | 说明 | 借鉴源 |
|------|------|--------|
| **事件基线** | 每个会话段落 → 一条 timeline_event，永久落盘不丢失 | 用户理念 |
| **强度加权** | 每条事件的记忆强度由多维信号动态计算，权重可配置 | 借鉴 openclaw 信号评分，但权重不进代码 |
| **分层检索** | Level 1(概览) → Level 2(主题搜索) → Level 3(原文回溯) | 用户理念 |
| **Agent 自主** | Agent 可 remember/forget/search 主动管理记忆 | hermes 工具模式 |
| **每日巩固** | 每天一次轻量 cron：重算昨日强度、去重合并 | openhanako ticker 简化版 |

### Phase 10 不做

- ❌ dreaming 三阶段巩固（留 Phase 11+）
- ❌ LLM 编译管道（daily/week/longterm 是摘要，非我们需求）
- ❌ 技能自创（手艺）
- ❌ 权重自调节（先可配置，自调节留 Phase 11+）

---

## 二、数据模型

### 2.1 timeline_events 表（SQLite）

```sql
CREATE TABLE timeline_events (
  id            TEXT PRIMARY KEY,          -- 事件 UUID
  session_id    TEXT NOT NULL,             -- 来源会话
  agent_id      TEXT,                      -- 绑定 Agent（可为 null）
  timestamp     TEXT NOT NULL,             -- ISO 8601 事件发生时间
  date          TEXT NOT NULL,             -- YYYY-MM-DD（分区键 + 日历查询）
  summary       TEXT NOT NULL DEFAULT '',  -- 一句话摘要（LLM 生成）
  intensity     REAL NOT NULL DEFAULT 0,   -- 0.0 ~ 1.0 记忆强度
  raw_signals   TEXT NOT NULL DEFAULT '{}', -- JSON: 各项原始信号值（不存权重）
  message_count INTEGER NOT NULL DEFAULT 0, -- 段落内消息数
  tool_calls    INTEGER NOT NULL DEFAULT 0, -- 工具调用次数
  duration_sec  INTEGER NOT NULL DEFAULT 0, -- 事件持续秒数
  topics        TEXT NOT NULL DEFAULT '[]', -- JSON: 主题标签
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  intensity_updated_at TEXT                -- 强度最后重算时间
);

CREATE INDEX idx_timeline_date     ON timeline_events(date);
CREATE INDEX idx_timeline_session  ON timeline_events(session_id);
CREATE INDEX idx_timeline_agent    ON timeline_events(agent_id);
CREATE INDEX idx_timeline_intensity ON timeline_events(intensity);

-- FTS5 全文搜索
CREATE VIRTUAL TABLE timeline_fts USING fts5(
  summary,
  topics,
  content=timeline_events,
  content_rowid=rowid,
  tokenize='unicode61'
);
```

### 2.2 强度计算——权重不在代码，在配置

强度计算**只存原始信号值**（`raw_signals`），不存权重。每次查询时动态计算。

```ts
// raw_signals JSON 格式（每条事件存储）
{
  "duration_sec": 1245,        // 原始值
  "message_count": 23,         // 原始值
  "tool_calls": 5,             // 原始值
  "topic_convergence": 0.7,    // 预计算值（话题收敛度）
  "user_marked": false,        // Agent 是否显式标记为重要
  "recall_count": 3            // 后续被检索引用的次数
}
```

```ts
// src/config/memory-profile.ts — Agent 可配置的记忆画像
interface MemoryProfile {
  /** 各信号的归一化上限 */
  limits: {
    durationSec: number;    // 默认 3600（超过 1 小时都按 1 小时算）
    messageCount: number;   // 默认 50
    toolCalls: number;      // 默认 20
    topicConvergence: number; // 默认 1.0
  };

  /** 信号转强度分数的权重（可被 Agent 覆盖，默认值来自 openclaw 经验） */
  weights: {
    duration: number;       // 默认 0.25
    messageCount: number;   // 默认 0.20
    toolCalls: number;      // 默认 0.20
    topicConvergence: number; // 默认 0.15
    userMarked: number;     // 默认 0.10（显式标记加权）
    recency: number;        // 默认 0.10（时间衰减已单独处理）
  };

  /** 强度半衰期（天） */
  halfLifeDays: number;     // 默认 30
}

// 默认出厂 MemoryProfile（来自 openclaw 经验值）
const DEFAULT_MEMORY_PROFILE: MemoryProfile = {
  limits: { durationSec: 3600, messageCount: 50, toolCalls: 20, topicConvergence: 1.0 },
  weights: { duration: 0.25, messageCount: 0.20, toolCalls: 0.20, topicConvergence: 0.15, userMarked: 0.10, recency: 0.10 },
  halfLifeDays: 30,
};
```

**强度计算公式**（查询时动态计算）：

```
normalized_signal = min(raw_value / limit, 1.0)
raw_intensity     = sum(weight_i * normalized_signal_i)
effective_intensity = raw_intensity * exp(-ln(2) * days_ago / halfLifeDays)
```

### 2.3 分层检索

```ts
// Level 1 — 概览（纯 SQL，无 LLM）
// "最近一周发生了什么？"
SELECT date, summary, effective_intensity
FROM timeline_events
WHERE date BETWEEN ? AND ?
ORDER BY effective_intensity DESC
LIMIT 20;

// Level 2 — 主题搜索（FTS5 + tag，无 LLM）
// "关于沙箱我们讨论过什么？"
SELECT te.* FROM timeline_events te
JOIN timeline_fts tf ON te.rowid = tf.rowid
WHERE timeline_fts MATCH ?
ORDER BY te.effective_intensity DESC;

// Level 3 — 原文回溯（通过 session_id 定位 JSONL）
// "7 月 28 日下午沙箱对话的细节"
// → 从 timeline_events 找到 session_id → 读取 PI JSONL
```

---

## 三、API 设计

### 3.1 memory 工具（Agent 可调用）

借鉴 hermes 批处理模式：

```ts
// search_memory
{
  name: "search_memory",
  parameters: {
    query?: string,          // FTS5 全文搜索
    date_from?: string,      // YYYY-MM-DD
    date_to?: string,
    level: "overview" | "detail" | "full",  // 检索深度
    limit?: number           // 默认 10
  }
}

// remember（Agent 显式标记重要事件）
{
  name: "remember",
  parameters: {
    event_id?: string,       // 标记已有事件
    content?: string,        // 或新建一条记忆
    importance: "low" | "medium" | "high"  // 影响 user_marked 信号
  }
}

// forget（降低强度或归档）
{
  name: "forget",
  parameters: {
    event_id: string,
    reason?: string          // Agent 自我解释为什么遗忘
  }
}
```

### 3.2 HTTP API

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/memory/timeline?from=&to=&limit=` | 获取时间线事件 |
| GET | `/api/memory/search?q=&from=&to=&level=` | 搜索记忆 |
| GET | `/api/memory/timeline/:eventId` | 事件详情（含强度明细） |
| POST | `/api/memory/remember` | Agent 标记记忆 |
| DELETE | `/api/memory/events/:eventId` | 遗忘事件（降低强度） |
| GET | `/api/agents/:id/memory-profile` | 获取 Agent 的记忆画像 |
| PUT | `/api/agents/:id/memory-profile` | 更新 Agent 的记忆画像 |

---

## 四、核心模块

### 4.1 `src/memory/` 新模块

| 文件 | 职责 |
|------|------|
| `src/memory/event-store.ts` | timeline_events 的 CRUD + FTS5 同步 |
| `src/memory/intensity-calculator.ts` | 强度计算引擎（纯函数，无副作用） |
| `src/memory/memory-service.ts` | 组合根：event-store + 强度计算 + 每日巩固 |
| `src/memory/memory-profile-store.ts` | Agent memory-profile 的读写 |
| `src/contracts/memory.ts` | 类型定义：TimelineEvent, MemoryProfile, SearchQuery 等 |

### 4.2 `src/server/routes/memory.ts` — 记忆 HTTP API

### 4.3 `web/src/features/` — 记忆时间线可视化

新增页面 `/memory`：
- 横轴时间（天为单位），纵轴强度（0~1）
- 每个事件显示为彩色条形
- 颜色编码（coding=蓝 / design=绿 / 决策=橙 / 日常=灰）
- 点击条形展开 Level 2 详情
- 基于 `GET /api/memory/timeline` 数据渲染

---

## 五、会话集成

### 5.1 会话结束 → 自动生成事件

在 `src/server/routes/messages.ts` 或 session runtime 中：
- 会话中的每个 turn 批次（N 条消息或一次工具调用密集段）→ 生成一条 timeline_event
- 调用 LLM 生成一句话 summary（mini prompt，非常轻量）
- 统计 message_count、tool_calls、duration_sec
- 提取 topics（基于工具名称 + 关键词）

### 5.2 每日 cron

借鉴 openhanako memory-ticker 但大幅简化：
- 每天凌晨（或 Agent Server 启动时）执行一次
- `recalculateIntensities()`：重算昨日所有事件的强度（此时 recall_count 等后续数据已可用）
- `consolidateDuplicateEvents()`：合并同一天内高度相似的事件

### 5.3 system prompt 注入

不注入整个 memory.md，而是注入：
- 当前会话绑定的 Agent 的记忆画像
- 最近 7 天内强度 > 0.5 的事件摘要（Level 1 概览）
- 每次对话开始时冻结快照（hermes 模式），保持前缀缓存稳定

---

## 六、文件变更清单

### 6.1 新增文件

| 文件 | 说明 |
|------|------|
| `src/memory/event-store.ts` | timeline_events CRUD + FTS5 |
| `src/memory/intensity-calculator.ts` | 强度计算引擎 |
| `src/memory/memory-service.ts` | 记忆服务组合根 |
| `src/memory/memory-profile-store.ts` | Agent 记忆画像存储 |
| `src/contracts/memory.ts` | 记忆相关类型定义 |
| `src/server/routes/memory.ts` | 记忆 API 路由 |
| `src/storage/migrations.ts` | 新增 timeline_events + timeline_fts 建表迁移 |
| `web/src/features/memory/MemoryTimeline.tsx` | 时间线可视化组件 |
| `web/src/features/memory/MemoryTimeline.module.css` | 样式 |
| `web/src/pages/MemoryPage.tsx` | /memory 页面 |
| `tests/unit/intensity-calculator.test.ts` | 强度计算单元测试 |
| `tests/unit/event-store.test.ts` | 事件存储单元测试 |
| `tests/integration/memory-api.test.ts` | 记忆 API 集成测试 |

### 6.2 修改文件

| 文件 | 说明 |
|------|------|
| `src/storage/database.ts` | 数据库初始化 + 迁移 |
| `src/server/app.ts` | 注册 memory 路由 |
| `src/server/routes/messages.ts` | 会话结束后触发事件生成 |
| `src/runtime/session-runtime.ts` | session 结束时调用 memory-service |
| `web/src/app/page-router.ts` | 新增 /memory 路由 |
| `web/src/app/state.ts` | 新增记忆相关状态 |
| `web/src/lib/sse-client.ts` | 新增 memory.* 事件类型 |

---

## 七、任务拆分与依赖

```
Task 1 (契约 + 数据模型, 主Agent 串行先行)
  ├─→ Task 2 (event-store + 迁移, 子Agent)
  │    ├─→ Task 3 (intensity-calculator + memory-service, 子Agent)
  │    │    └─→ Task 4 (Server 路由 + Session 集成, 子Agent)
  │    │         └─→ Task 5 (Web UI 时间线, 子Agent)
  │    └─→ Task 6 (memory-profile-store, 子Agent) ← 并行于 3/4
  └─→ Task 7 (测试文件, 子Agent) ← 并行于 2-5
       └─→ Task 8 (质量门 + browser-use, 主Agent)
```

---

## 八、质量门

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json

# browser-use：验证 /memory 时间线页面 + Agent 设置中的记忆画像配置
```

---

## 九、验收标准

- [ ] timeline_events 表正确创建，FTS5 索引生效
- [ ] 会话结束后自动生成 timeline_event，强度计算正确
- [ ] search_memory Level 1/2/3 三种检索深度均可正常工作
- [ ] remember/forget 工具可被 Agent 调用，影响强度
- [ ] MemoryProfile 权重可配置，不同 Agent 可有不同画像
- [ ] Web UI `/memory` 页面展示时间线可视化（横轴时间/纵轴强度）
- [ ] Agent 设置页可编辑记忆画像
- [ ] 强度计算使用归一化信号 + 指数衰减，不含硬编码权重
- [ ] 全部质量门通过
- [ ] browser-use 验收通过

---

## 实施记录

（实施中回填）

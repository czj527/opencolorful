# OpenColorful 记忆系统架构 — 数据流与存储

> 2026-07-30 v2 | Phase 10/10.5 设计依据
> 回答一个问题：**会话数据从产生到成为记忆，怎么流动、存在哪里、怎么被读取和遗忘。**
> 策略：**热层四段传送带照抄 openhanako**（生产验证），**深层时间线全量库 + 分层查询工具是我们的增量**；记忆 agent 与评价体系在 Phase 10.5 引入。
> 配套：[positioning-and-roadmap.md](positioning-and-roadmap.md)、[infrastructure-decisions.md](infrastructure-decisions.md) 第五章

## 一、设计原则

1. **上下文是唯一出口**：LLM 只看得见每轮传入的上下文。记忆系统本质是一台"上下文编译器"——存储和加工都是手段，最终产物是注入的那一帧记忆块。注入契约（结构/预算/刷新规则）是唯一稳定接口，内部实现可演进。
2. **JSONL 永存，制品可重建**：PI JSONL 是消息正文唯一事实源，永不删除。memory.md、facts、events 全是它的**编译产物/索引**，任何一层损坏都可从 JSONL 重建。
3. **热层抄 openhanako**：今天 / 本周早些时候 / 长期情况 / 重要事实四段传送带，turn-based 驱动——近期记忆的及时体感由它保证（"连最近两天都记不住的 agent 不值得用"）。
4. **深层按时间排序**：全量会话按时间横向排序建事件索引；事实是对事件的垂直提取。查询从事实下钻到事件、再下钻到原文，层层深入。
5. **分层即遗忘**：不重要记忆随传送带折叠自然失去细节与可达性——遗忘的是"被想起的概率"，不是档案。强度信号（Phase 10.5 引入）只用于时间线 UI 展示与检索排序辅助，**不作为遗忘机制**；权重可人工配置，不做自调节。
6. **LLM 有降级路径**：每个 LLM 环节都有零 LLM 兜底，LLM 不可用时记忆系统不停摆（openhanako 的教训）。

## 二、总览图

```
┌────────────────────────────── 数据源（已有，不动） ──────────────────────────────┐
│  用户 ↔ PI Agent Loop → 消息/工具调用实时追加到 PI JSONL                          │
│  （agents/<id>/sessions/*.jsonl）★ 原文档案 · 唯一事实源 · 永不删除               │
└──────────────────────────────┬───────────────────────────────────────────────────┘
                               │ turn.completed（已有事件钩子）
                               ▼
┌────────────────────────── MemoryTicker（turn-based 触发） ──────────────────────┐
│  每 10 轮 → rolling summary │ 会话结束/分支变更 → 补摘要 │ 跨日 → 每日任务        │
│  启动恢复扫描（24h）│ 1h 兜底 timer │ 断点续跑（daily-state.json）                │
└──────────────────────────────┬───────────────────────────────────────────────────┘
                               ▼
┌────────────────────────── 摘要层：rolling summary ──────────────────────────────┐
│  读 JSONL 增量（cursor 水位线）→ LLM 生成两节：### 重要事实 + ### 时间线           │
│  → 格式校验（失败修复 1 次）→ session_summaries 表（cursor 绑定分支 lineage）     │
└──────────┬───────────────────────────────┬──────────────────────────────────────┘
           │                               │
           ▼ 传送带（热层，照抄 openhanako）  ▼ 深潜线
┌────────────────────────────────┐  ┌───────────────────────────────────────────┐
│ today.md（今天，3-5 条粗事件）   │  │ ① 事件索引（rolling summary 副产品，       │
│  │ compileToday 增量水位线      │  │   零额外 LLM）：每个摘要批次 → 一条        │
│  │ 跨日重置                    │  │   memory_events（date/session/摘要/       │
│  ▼ LLM 蒸馏（每日 S0）          │  │   topics/消息数/工具数/时长）             │
│ daily/{date}.md（2-3 句日记）   │  │   → 时间的横向排序，深层检索基座           │
│  │                             │  │                                           │
│  ▼ 纯文件装配，零 LLM           │  │ ② 事实提取（每日 S5，脏摘要 → LLM →        │
│ week.md（最近 6 天日记拼接）    │  │   memory_facts，FTS5 + CJK n-gram +       │
│  │ 超出 6 天部分                │  │   provenance 溯源）— 记忆的垂直提取        │
│  ▼ LLM 折叠（每日 S2）          │  └───────────────────────────────────────────┘
│ longterm.md（≤400字长期画像）   │
│                                │
│ facts.md（≤200字，与摘要事实节   │
│   双向往复，可编辑）            │
└───────────────┬────────────────┘
                │ assemble() 拼四段
                ▼
┌────────────────────────── 成品：memory.md ──────────────────────────────────────┐
│  ## 重要事实 ← facts.md   ## 今天 ← today.md                                    │
│  ## 本周早些时候 ← week.md   ## 长期情况 ← longterm.md（空段填占位符）           │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ 重编译后热更新 system prompt（限频：每 10 轮一批）
                ▼
┌────────────────────────── 注入（每轮在场） ─────────────────────────────────────┐
│  system prompt 末尾：记忆使用规则 + # Pinned + # Memory(memory.md)               │
│  预算截断 + 注入前威胁扫描 + 落盘前 PII 脱敏                                     │
└─────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────── 读取路径：分层查询工具（主 agent 主动调用） ──────────┐
│  L0 注入层：memory.md —— 零成本，已在上下文                                      │
│  L1 事实层：search_facts —— 查询第一站（tags → FTS5 → LIKE）                    │
│  L2 事件层：search_events（时间范围 + 主题）—— 事实不清晰/有出入时下钻           │
│  L3 原文层：recall_session（JSONL 行段）—— 需要精确细节时回溯                    │
│  工具均返回 provenance（日期/session/事件引用），据此判断是否继续深挖             │
│  写工具：remember（记事实）/ forget（带 reason 放逐）/ pin_memory / unpin_memory │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 三、热层：四段传送带（openhanako 照抄部分）

| 段 | 来源 | 更新时机 | 上限 | LLM |
|---|---|---|---|---|
| today.md（今天） | rolling summary 增量编译（水位线） | 每 10 轮后；跨日重置 | 3-5 条粗事件，带时间锚点 | ✅ |
| daily/{date}.md（日记） | 昨天 today.md 蒸馏 | 每日任务 S0 | 2-3 句话（≤60 字） | ✅ |
| week.md（本周早些时候） | daily/ 最近 6 天拼接 | 每日任务 S4 | ≤1200 字符 | ❌ 零 LLM |
| longterm.md（长期情况） | 滚出 6 天窗口的日记折叠 | 每日任务 S2 | ≤400 字 | ✅ |
| facts.md（重要事实） | 与摘要"重要事实"节双向往复 | 每日任务 S3 + 增量 | ≤200 字 | ✅ |

每日任务流水线（日期变化时跑，`daily-state.json` 断点续跑）：
S0 compileDaily → S1 compileToday（新日重置）→ S2 rollDailyWindow → S3 compileFacts → S4 装配 week+memory.md 并刷新 prompt → S5 深潜（脏摘要→事件索引+事实提取）。

**遗忘在这里发生**：today→daily 丢细节、daily→longterm 折叠取舍、today 覆盖式更新以新为准——没有任何评分，遗忘是传送带的有损折叠。

## 四、深层：时间线事件库（我们的增量）

openhanako 的深层只有 facts.db（原子事实，无时间叙事）。我们增加 **memory_events**：每个 rolling summary 批次顺手落一条事件（摘要的时间线节文本直接复用，**零额外 LLM 调用**），按 `date` 分区、按时间排序。

它回答 facts 答不了的问题："7 月发生了什么""沙箱那件事的来龙去脉"——事实不清晰/与实际有出入时，agent 下钻到事件层看时间叙事，再下钻到 JSONL 原文看逐字记录。

## 五、读取路径：分层查询与下钻规则

| 层 | 工具 | 数据源 | 何时用 |
|---|---|---|---|
| L0 | （无需工具，已注入） | memory.md + pinned | 回答"最近/今天/本周" |
| L1 | `search_facts` | memory_facts | 查询第一站，回答"我知道什么" |
| L2 | `search_events` | memory_events（FTS5+日期） | 事实不清晰、相互矛盾、需要经过时 |
| L3 | `recall_session` | PI JSONL 行段 | 需要逐字原文、改了哪些文件时 |

下钻规则写进 system prompt 记忆使用规则：先事实，事实不清晰或与当前认知冲突时下钻事件，需要精确细节时下钻原文。每层工具返回 provenance，支撑 agent 判断。

## 六、注入契约（稳定接口）

```
# 记忆使用规则（固定文本：像空气一样内化；禁止说"我记得"；当前对话优先；
#                事实不清晰时用记忆工具下钻查证）
# Pinned Memories ← pinned_memories 表渲染
# Memory          ← memory.md 四段全文
```

- **预算**：整块默认 ≤2500 字符（CJK 按字符近似 token），超限按 今天 > 重要事实 > Pinned > 本周 > 长期 优先级截断
- **刷新**：openhanako 热更新模式——重编译后刷新 system prompt，每 10 轮一批天然限频；"冻结快照"模式留作后续可配置项，由评测数据裁决默认值
- **安全**：注入前逐段威胁扫描（命中替换 `[BLOCKED]`）；事实/摘要落盘前 PII 脱敏
- **排除**：未绑定会话不产生记忆；当前会话内容不重复注入（它本就在上下文里）

## 七、存储布局

```
~/.opencolorful/
├── metadata.sqlite
│   ├── sessions / usage_records          （已有，不动）
│   ├── session_summaries                 【新】rolling summary + cursor + snapshot
│   ├── memory_events (+_fts FTS5)        【新】时间线事件索引（深层）
│   ├── memory_facts  (+_fts FTS5)        【新】事实库（含 provenance/有效期）
│   ├── memory_recalls                    【新】检索命中记录（P10 只写不算）
│   ├── memory_daily_state                【新】每日任务断点
│   └── pinned_memories                   【新】置顶
└── agents/<id>/
    ├── identity.json / base-color.json / settings.json   （已有，不动）
    ├── sessions/*.jsonl                  ← PI 原文档案（永不删除）
    └── memory/                           【新】agent 即文件夹的可读记忆
        ├── memory.md / today.md / week.md / longterm.md / facts.md
        ├── daily/YYYY-MM-DD.md
        └── state/（today/facts 水位线、daily-state、reset 标记）
```

| 层 | 删除语义 |
|---|---|
| PI JSONL | 永不自动删；仅用户显式删除会话 |
| memory/ md 文件 | 编译产物，可全量重建；daily 源文件折叠进 longterm 后删除 |
| memory_events / facts | forget 放逐（留痕）；用户可硬删除；可重扫 JSONL 重建事件 |
| session_summaries | 随会话归档保留；可重扫重建 |

维护命令：`memory rebuild`（重扫 JSONL 全量重建索引与制品，对齐 openclaw doctor 思路）。

## 八、FTS5 是什么 & 为什么用它（不用向量数据库）

FTS5 是 **SQLite 内置的全文检索引擎**（better-sqlite3 自带，零新增依赖）：建一张虚拟表对指定列建倒排索引，`MATCH` 查询毫秒级返回，BM25 相关度排序，openhanako/hermes 的事实库都用它。

- **为什么不用向量**：我们的核心查询是时间范围与精确主题（"近三天""关于沙箱"），向量没有时间结构；向量要 embedding 模型（API 泄露隐私/本地重依赖）；个人 agent 数据量小，FTS5 足够。向量作为后期可选增强（Phase 12+），schema 预留位置即可。openhanako v1→v2 也是从向量 KNN 迁到 FTS5。
- **CJK 盲区与解法**：FTS5 默认 unicode61 分词器对中文按整段处理，单字/词组查不到。解法（照抄 openhanako）：写入时对中文片段生成 2-gram/3-gram 存入 `search_text` 列一并索引，查询时同样处理。

## 九、降级与边界

| 情况 | 行为 |
|---|---|
| LLM 不可用 | 摘要/编译暂停并积压水位线，事件索引用零 LLM 统计信息照常落；恢复后补跑。系统不停摆 |
| 进程崩溃/不在线 | 不整理（无守护进程）；启动恢复扫描 24h 内会话补摘要；daily-state 断点续跑 |
| 未绑定会话 | 无 agent 记忆目录，不产生记忆（stateless）；JSONL 照常保留 |
| compact 发生 | 无关——记忆从 JSONL 读取，与上下文窗口压缩是两条独立通路 |
| 会话归档 | 记忆制品保留；归档会话的事件/事实仍可检索 |

## 十、Phase 映射

| Phase | 范围 |
|---|---|
| **10（底座）** | 本文 §三~§九 全部：ticker、rolling summary、四段传送带、事件索引、事实提取（脚本化深潜）、分层工具、注入契约、FTS5+CJK、恢复扫描、/memory 只读页 |
| **10.5（原创层）** | **记忆 agent** 接管深潜（事实提取/冲突裁决/旧识失效标记，参考 hermes curator 后台 agent 模式）；记忆 agent LLM 接入（per-agent → 全局 → 宿主三级解析链）与记忆设置方案（全局/per-agent 覆盖 + 设置中心页）；强度信号（仅展示/排序辅助）+ **时间线 UI 图**（横轴时间/纵轴强度/强度分解）；评测台暂缓，后续单独评估 |
| **11（日志）** | 结构化日志框架；记忆全链路埋点（P10 代码先留钩子） |
| **12+** | 向量增强（可选）、梦境巩固（用 memory_recalls 数据） |

---

*本文档为记忆系统数据流与存储权威。plans/phase-10.md、phase-10.5.md 应与本文对齐。*

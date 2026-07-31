# OpenColorful 记忆系统架构 - 数据流与存储

> 2026-07-31 v3 | Phase 10/10.5/11 设计依据
> 回答一个问题：**会话经历如何成为近期上下文、长期记忆，以及可被主 Agent 主动回想的证据。**
> 策略：**四段 Markdown 传送带照抄 openhanako**（生产验证）；长期记忆与上下文记忆分离；记忆 Agent 在空闲窗口整理长期记忆；Phase 11 统一记录结构化日志。
> 配套：[positioning-and-roadmap.md](positioning-and-roadmap.md)、[infrastructure-decisions.md](infrastructure-decisions.md) 第五章

## 一、设计原则

1. **两条记忆通道**：`today.md/week.md/longterm.md/facts.md/memory.md` 是自动注入的上下文记忆；长期记忆库默认不注入，只能由主 Agent 主动 `search_memory` 回想。
2. **原文与记忆意志分离**：PI JSONL 是经历正文的唯一事实源；`memory_journal` 是 remember、forget、pin、supersede、suppression 等记忆意志的追加式权威。SQLite 表和 Markdown 都是可重建投影。
3. **热层照抄 openhanako**：四段 Markdown 使用 rolling summary、turn-based ticker、水位线和跨日整理，优先保证单会话及近期会话的连续性。
4. **长期记忆由记忆 Agent 管理**：主 Agent 只能读取长期记忆并产生记忆意图，不能直接写入、修改强度、晋升永久或遗忘；记忆 Agent 提交提案，平台策略审批后事务性应用。
5. **回想是一等认知活动**：`search_memory` 是长期记忆的统一只读入口；回想过程具有独立的 RecallEpisode 和 SSE 状态，与 thinking、browsing 同级，不降格为普通工具卡。
6. **强度不是活跃度**：长期记忆同时记录 `retentionStrength`（固化强度）和 `activationStrength`（唤起强度）。短期/中期/永久层级由固化强度决定；回想命中只记录证据，不能直接提升强度。
7. **防止自我强化**：注入记忆和回想结果带 `sourceType` 标记；`memory_recall`、`injected_memory`、Agent 自己的复述不能作为独立强化证据。
8. **遗忘降低可达性**：认知遗忘通过状态、有效期和 suppression 实现，原始经历默认保留。用户的数据删除权不依赖记忆 Agent。
9. **LLM 有降级路径**：四段 Markdown、事件索引、封存批次和回想检索在 LLM 不可用时仍可工作；整理失败只积压提案，不阻塞主对话。

## 二、总览图

```
┌──────────────────────────── 数据源（唯一经历档案） ────────────────────────────┐
│ 用户 ↔ 主 Agent Loop → 消息/工具调用追加到 agents/<id>/sessions/*.jsonl       │
│ JSONL 保存原始经历；注入内容、回想结果和后台整理提示均带 sourceType          │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ turn.completed / session end
                                   ▼
┌──────────────────────────── MemoryTicker（Phase 10） ─────────────────────────┐
│ 每 10 轮滚动摘要；会话结束补摘要；跨日 S0-S4；启动恢复；每 Agent 串行队列       │
│ 只负责近期上下文、事件索引、recall ledger 和 sealed_memory_batch，不改长期强度 │
└───────────────────────┬───────────────────────────────┬────────────────────────┘
                        │                               │
                        ▼                               ▼
┌──────────── 上下文记忆通道（自动在场） ───────────┐  ┌──────── 长期记忆通道（主动回想） ────────┐
│ rolling summary → today.md                        │  │ memory_events：零额外 LLM 的时间索引      │
│ today → daily/YYYY-MM-DD.md                       │  │ sealed_memory_batch：待整理经历批次       │
│ daily → week.md → longterm.md                     │  │ recall ledger：回想命中、来源、日期、层级 │
│ summary facts → facts.md                          │  │ memory_journal：记忆意志和 suppression     │
│ assemble → memory.md → 下一轮 system prompt      │  │ memory_facts：记忆 Agent 已审批的原子记忆  │
│ 参考 openhanako；上一版可用；不读取长期库反写    │  │ 默认不注入，只由 search_memory 读取        │
└──────────────────────────┬────────────────────────┘  └──────────────────┬─────────────────────┘
                           │ 自动注入                                主 Agent 调用
                           ▼                                               │
                   ┌──────────────┐                                        ▼
                   │ 主 Agent 当前上下文 │                         ┌──────────────────────────┐
                   └──────────────┘                         │ RecallEpisode（回想）     │
                                                            │ facts → events → source   │
                                                            │ started/layer/completed    │
                                                            └──────────────┬───────────┘
                                                                           │ 只读结果 + provenance
                                                                           ▼
                                                                  当前回答上下文

┌──────────────────── 后台整理（Phase 10.5，主 Agent 休息时） ───────────────────┐
│ Session 结束封存；每日 03:00 本地时间且 Agent 空闲 ≥30 分钟时批量运行            │
│ 读取 sealed batches + recall ledger + 长期库 + PathGuard 受限原文                │
│ 记忆 Agent → 提交强度/合并/失效/晋升提案 → MemoryPolicy 校验 → SQLite 事务提交   │
│ 每周复核跨日期命中和永久候选；整理中的半成品对主 Agent 不可见                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**通道边界**：Markdown 记忆解决“当前交流是否连贯”；长期记忆解决“Agent 一生经历能否被主动找回”。长期记忆被回想不会自动写回 Markdown，Markdown 的滚动也不会直接改变长期记忆强度。

## 三、热层：四段传送带（openhanako 主干）

| 段 | 来源 | 更新时机 | 上限 | LLM |
|---|---|---|---|---|
| `today.md` | rolling summary 增量水位线 | 每 10 轮；跨日重置 | 3-5 条粗事件 | 是 |
| `daily/{date}.md` | 昨天的 today 草稿蒸馏 | 每日 S0 | 2-3 句话，≤60 字 | 是 |
| `week.md` | 最近 6 天 daily 纯文件拼接 | 每日 S4 | ≤1200 字符 | 否 |
| `longterm.md` | 滚出窗口的 daily 折叠 | 每日 S2 | ≤400 字 | 是 |
| `facts.md` | rolling summary 的事实节编译 | 每日 S3 + 增量 | ≤200 字 | 是 |

每日任务保持 openhanako 顺序：

```text
S0 compileDaily → S1 compileToday → S2 rollDailyWindow
→ S3 compileFacts → S4 assemble week + memory.md → publish next revision
```

四段文件是可重建的上下文制品，不是长期记忆库。`longterm.md` 的“长期”只表示上下文中的长期背景摘要，不等于永久记忆。

## 四、长期记忆与记忆强度

长期库以原子 `MemoryItem` 保存事件、事实、偏好、关系和约定，并保留 `sourceRefs`、有效期、状态和审计信息。

```text
retentionStrength  固化强度：短期 / 中期 / 永久层级
activationStrength 唤起强度：当前是否容易被搜索命中
confidence         可信度：来源和核验的可靠程度
status             active / superseded / forgotten / suppressed
```

- 主 Agent 的回想只更新 recall ledger；activation 统计由平台确定性更新，事实来源仍是 recall ledger，不直接改 retention strength。
- 只有记忆 Agent 根据跨会话/跨日期命中、用户确认、独立来源和冲突情况提出强度变更。
- 短期可自动强化为中期；中期晋升永久必须满足多来源、高可信度、无未解决冲突，由 MemoryPolicy 审批。
- 永久表示不自动衰减，不代表不可 supersede、forget 或被用户删除。
- `pinned` 是独立的展示/检索覆盖，不等于强度 100。

## 五、回想：长期记忆的主动读取路径

主 Agent 默认只调用一个入口：`search_memory(query, depth?)`。内部按需下钻：

```text
search_memory → facts → events → source session
```

`search_events` 与 `recall_session` 保留为内部下钻和高级控制接口，不作为默认第一站。一次多层查询聚合成一个 `RecallEpisode`，并广播：

```text
memory.recall.started
memory.recall.layer_changed
memory.recall.completed | memory.recall.empty | memory.recall.failed | memory.recall.cancelled
```

事件至少包含 `recallId/sessionId/agentId/turnId/layer/status/resultCount/startedAt/completedAt`，并持久化到 `memory_recall_events` 供 SSE Replay。UI 文案可采用“正在努力回想 / 正顺着往事继续寻找 / 想起来了 / 没有找到相关记忆”。

回想结果是证据，不是指令；结果带 `provenance`、`confidence`、`strengthTier`、`validFrom/validUntil` 和 `sourceType=memory_recall`。没有结果与技术失败必须区分。

## 六、封存与后台整理时序

### 6.1 交互中

- MemoryTicker 只更新四段 Markdown、rolling summaries、事件索引和 recall ledger。
- 主 Agent 可以产生 `memory_intent`（remember/forget/pin/unpin），但它只是追加到 `memory_journal` 的待处理意图，不直接修改 `memory_facts`。pin/unpin 属 Markdown 通道，由平台**即时应用**并同步 journal 留痕，不等审批窗口。
- 当前 Session 的注入内容、回想结果和 Agent 复述不作为独立强化证据。

### 6.2 Session 封存

Session 结束、归档或长时间无活动时，创建 `sealed_memory_batch`，包含 session/branch revision、source range、summary revision、recall ledger 引用和待处理意图。长会话可以按批次创建 provisional batch，但不能凭此直接晋升永久。

### 6.3 每日与每周窗口

- 每日默认 `03:00`（本地时区），且 Agent 空闲至少 30 分钟才运行记忆 Agent。
- 高优先级 intent 若 Session 仍持续，在当前 turn 完成后创建限定 source range 的 micro-seal，不关闭 Session。
- 每 Agent 独立串行；有活动时跳过并在下一次 housekeeping tick（复用 1 小时兜底 timer）重试；进程重启按 `memory_watermarks` + `scheduler_state` 恢复，不以固定 24 小时作为唯一依据。
- 每日整理提取候选、核验、合并、短期→中期强化、冲突失效和意图处理。
- 每周复核跨日期/跨 Session 的独立命中、永久候选、重复和矛盾。
- 整理生成 proposal，经 MemoryPolicy 校验后在单个 SQLite 事务中提交；半成品不可被主 Agent 读取。

### 6.4 角色隔离

记忆 Agent 是 headless 内部整理者，不出现在用户 Agent 列表，不读取主 Agent 的底色、完整 system prompt 或当前工作上下文，无 shell、网络和原文写入权限。它只看到规则、封存批次、长期库、recall ledger 和受限原文读取结果。

## 七、注入契约与安全

```text
# 记忆使用规则（当前对话优先；长期事实不确定时调用 search_memory）
# Pinned Memories ← Markdown 通道的 pinned 投影
# Memory          ← memory.md 四段全文
```

- 长期记忆库不自动注入；`search_memory` 的工具结果才进入当前上下文。
- `memory.md` 默认 ≤2500 字符，超限按今天 > 重要事实 > Pinned > 本周 > 长期截断；Pinned 应有独立保底预算。
- 新 revision 生成后从下一轮开始生效；编译失败继续使用上一版。
- 注入前威胁扫描，落盘前 PII 脱敏；回想结果和注入内容禁止参与自身强化。
- 未绑定会话不产生 Agent 记忆；主 Agent 不能绕过策略直接写长期库。

## 八、存储布局与删除语义

```
~/.opencolorful/
├── metadata.sqlite
│   ├── sessions / usage_records             （已有）
│   ├── session_summaries                    【热层】rolling summary + cursor
│   ├── memory_events (+_fts FTS5)           【长期索引】时间线事件
│   ├── memory_facts (+_fts FTS5)            【长期记忆】已审批原子记忆
│   ├── memory_journal                       【权威】记忆意志、suppression、提案结果
│   ├── memory_batches                       【队列】sealed/provisional batch
│   ├── memory_recalls / memory_recall_episodes【证据】回想命中与 UI 状态
│   ├── memory_recall_events                 【回放】RecallEpisode 状态历史
│   ├── memory_daily_state / memory_watermarks / scheduler_state 【断点】恢复权威
│   └── memory_mutation_proposals            【审批】记忆 Agent 提案
└── agents/<id>/
    ├── identity.json / base-color.json / settings.json
    ├── sessions/*.jsonl                     ← 原始经历档案
    └── memory/
        ├── memory.md / today.md / week.md / longterm.md / facts.md
        ├── daily/YYYY-MM-DD.md
        └── state/（Markdown 编译水位线和重置标记）
```

| 对象 | 删除/遗忘语义 |
|---|---|
| PI JSONL | 不自动删除；用户明确删除时由平台立即处理 |
| Markdown | 可重建投影；daily 折叠后可删除源文件 |
| `memory_facts` | `forgotten/superseded` 保留审计；硬删除必须写 suppression tombstone |
| `memory_journal` | append-only，记录所有意图、审批、撤销和 suppression |
| `memory_events` | 可由 JSONL 重建，但受 journal suppression 过滤 |

`memory rebuild` 必须同时读取 JSONL 与 `memory_journal`，否则被忘记或删除的记忆会复活。

## 九、检索与降级

FTS5 + CJK 2/3-gram 是 Phase 10 的默认检索；中文单字走安全的 LIKE 降级。向量检索不在当前阶段。

| 情况 | 行为 |
|---|---|
| 摘要/Markdown LLM 不可用 | 水位线不推进，上一版继续注入；事件索引和批次封存仍可用 |
| 记忆 Agent 不可用 | sealed batch 保持 pending，主 Agent 仍可回想旧 revision |
| 进程崩溃/不在线 | 启动按 dirty watermark 恢复摘要、封存和每日队列 |
| 主 Agent 重新开始工作 | 未提交 proposal 暂停/重校验；不暴露半成品 |
| 未绑定会话 | 不产生 Agent 记忆；JSONL 仍按 Session 保存 |
| 会话归档 | 记忆投影保留；事件和已审批事实仍可回想，除非被 suppression |

## 十、Phase 映射

| Phase | 范围 |
|---|---|
| **10（底座）** | openhanako 四段传送带、rolling summary、事件索引、FTS5+CJK、`search_memory` 只读回想、RecallEpisode 事件、recall ledger、`memory_intent`/sealed batch 队列、每日调度状态、/memory 只读页 |
| **10.5（原创层）** | 记忆 Agent、受限后台整理、retention/activation 强度、短期/中期/永久层级、proposal + MemoryPolicy 审批、冲突裁决/合并/失效、每日空闲整理和每周永久候选复核、时间线强度 UI、设置页 |
| **11（日志）** | 统一结构化日志和可观测性：回想、批次、调度、提案、审批、强度变化、降级、恢复和用户纠正全链路埋点 |
| **后续（未排期）** | 技能包、插件、向量增强等；梦境/三阶段 dreaming 当前不纳入路线 |

---

*本文档是记忆系统数据流、角色边界和存储语义的权威。`plans/phase-10.md`、`plans/phase-10.5.md` 应与本文对齐。*

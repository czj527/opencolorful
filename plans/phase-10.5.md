# Phase 10.5：记忆 Agent、强度巩固与后台整理

**状态：规划中** | 分支：`phase-10.5-memory-agent`
**基线：** `main`（Phase 10 验收点）
**架构权威：** [docs/memory-architecture.md](../docs/memory-architecture.md)
**参考：** Hermes `agent/curator.py` 的空闲/间隔调度与受限后台 fork；openhanako 的深层记忆整理机制

> 本阶段不做梦境/三阶段 dreaming，不做评测台；记忆 Agent 默认可配置为 experimental/opt-in，直到后续评测证明可以切换默认。

---

## 一、目标

1. 把 Phase 10 的 pending `sealed_memory_batch` 交给平台级 headless 记忆 Agent，在主 Agent 休息时完成长期记忆整理。
2. 实现 retentionStrength / activationStrength、短期/中期/永久层级、跨会话证据聚合和可解释的强度提案。
3. 用 proposal + MemoryPolicy 审批替代模型直接写库；支持事实提取、冲突裁决、合并、失效和认知遗忘。
4. 提供每日空闲整理、每周永久候选复核、运行报告、回滚/重试和时间线强度 UI。

### 明确不做

- 评测台、自动调权、向量检索、梦境/REM/Deep、shadow trial；
- 主 Agent 的人格、底色、完整 system prompt 或当前工作上下文注入记忆 Agent；
- 记忆 Agent 直接写原文、shell、网络或绕过 MemoryPolicy 修改正式记忆；
- 强度驱动的物理删除；永久记忆仍可 supersede、forget 或被用户删除。

---

## 二、记忆 Agent 定位与权限

记忆 Agent 是平台内部的 headless 整理者，不出现在用户 Agent 列表，也不可被用户直接对话。它只看到：

```text
整理规则 + sealed_memory_batch
+ 已审批 memory_facts/events + recall ledger
+ memory_journal 待处理 intent
+ PathGuard 受限的 source session 读取结果
```

工具白名单：

```text
read_session_entries      # PathGuard 只读，限定到 batch source range
search_memory_candidates  # 只读长期库，不创建 recall 强化证据
propose_fact
propose_strength_change
propose_supersede
propose_merge
propose_forget
propose_longterm_projection
report_run
```

它没有 `write_fact`、`increase_strength`、`promote_permanent` 等直接变更工具。模型只能生成 `MemoryMutationProposal`，由平台校验来源、版本、权限和策略后提交。

---

## 三、何时整理：Session 封存、每日空闲、每周复核

### 3.1 Session 封存

Session 结束、归档或长时间无活动后，Phase 10 创建 `sealed_memory_batch`。长会话可创建 provisional batch，但 provisional 只能产生候选，不能直接晋升永久。封存不阻塞 Session 关闭。

### 3.2 每日整理窗口

- 默认每天 `03:00`，使用本地时区；
- Agent 空闲至少 30 分钟才启动；若仍有活动，跳过并在下一次 housekeeping tick（复用 1 小时兜底 timer）重试；
- 每 Agent 独立串行队列，同一 Agent 不并发运行多个整理任务；
- 每日整理处理 pending batches、recall ledger 和高优先级 memory intents；
- 负责提取候选、读取原文核验、重复合并、短期→中期强化、冲突标记和有效期更新；
- 主 Agent 新一轮工作开始时，未提交 proposal 暂停或重新校验；半成品对主 Agent 不可见。

### 3.3 每周复核窗口

每 7 天对跨日期/跨 Session 的候选做一次低频复核：

- 聚合独立会话和独立日期的命中；
- 检查用户确认、反例和未解决冲突；
- 提出中期→永久晋升；
- 检查长期记忆之间的重复、矛盾和 stale 状态。

永久晋升不因单次长对话、单一 LLM 判断或同一会话重复提及而发生。

### 3.4 高优先级 intent

用户明确“请记住”“以后永远如此”“不要再记得这件事”时，主 Agent 只追加 `memory_journal` intent，并提高 batch priority。**当前 Session 结束后立即触发该 intent 的专项处理**；如果 Session 仍持续，则在当前 turn 完成后创建不关闭 Session 的 micro-seal batch，限定到该 turn 的 source range。该专项处理不等每日 03:00 窗口，仍经 MemoryPolicy 审批；记忆 Agent 不可用时保持 pending，下一窗口补处理。隐私删除由平台立即执行，不等待记忆 Agent。

---

## 四、强度模型

长期记忆的强度不是会话活跃度，而是记忆在 Agent 一生中应该被保留和再次找回的程度。每条原子记忆保存：

```text
retentionStrength  0..100，决定短期 / 中期 / 永久层级
activationStrength 0..100，表示近期是否容易被唤起
confidence         0..1，来源和核验可靠程度
strengthTier       short | medium | permanent
status             active | superseded | forgotten | suppressed
```

**更新路径分离**：`activationStrength` 由平台在 recall 命中时确定性更新（独立日期封顶、随时间衰减，**不经 proposal**）；`retentionStrength` 只能经记忆 Agent 提案 + MemoryPolicy 审批。`memory_facts.activation_strength` 只是可重建的物化投影，`memory_recalls` 是 activation 的事实来源；每次命中先写 recall ledger，再在同一事务内更新投影，rebuild 时可由 ledger 重新计算。

### 4.1 固化强度信号

```text
来源强度 + 用户明确意图 + 跨会话/跨日期确认
+ 独立来源一致性 + 成功使用价值
- 冲突/纠正 - 时间衰减
```

- `recall ledger` 的命中次数只作为参考，不能直接 `strength += count`；
- 同一会话、同一日期和 `memory_recall`/`injected_memory` 不算独立确认；
- 用户明确永久化可以直接产生高强度意图；
- Agent 自动短期→中期；中期→永久必须多来源、高可信度、无未解决冲突，并经 MemoryPolicy 审批；
- 永久不自动衰减，但可 supersede、forget 或 delete；
- `pin` 独立于强度，不等于 100 分。

### 4.2 迟滞和分层

默认阈值：短期升中期 `45`，中期升永久 `85`。为避免来回跳层：中期降短期低于 `35`；永久不会因时间自动降级。阈值和策略可配置，但不自动调参。

### 4.3 记忆 Agent 提案

```json
{
  "type": "increase_strength",
  "memoryId": "mem_123",
  "previousStrength": 57,
  "proposedStrength": 68,
  "reason": "三个不同日期命中，两个 Session 有用户确认",
  "evidenceRefs": ["session:a", "session:b", "session:c"],
  "confidence": 0.91
}
```

所有 proposal 必须包含旧 revision、目标 revision、证据引用、策略原因和 actor；提交前重新检查版本，避免覆盖用户刚刚产生的 journal intent。

---

## 五、事实整理职责

| 职责 | 处理方式 |
|---|---|
| 候选提取 | 从 sealed batch 的 summary 和受限原文生成 proposal |
| 原文核验 | 仅读取 batch source range；不能写原文 |
| 冲突裁决 | 新旧事实并存；旧事实 `superseded` + `valid_until`，不静默覆盖 |
| 合并去重 | 同义事实合并，保留更完整 provenance；写 mutation journal |
| 认知遗忘 | 标记 forgotten/suppressed，默认检索不可见；原始经历保留 |
| 长期库投影 | 可生成解释性 projection，供长期检索/管理使用；不改写四段 Markdown 权威 |

主 Agent 不知道哪些记忆已经被遗忘。它只能在之后调用 `search_memory` 时看到 active 结果；空结果不区分“从未记住”和“后来忘记”。管理员和运行报告仍可查看历史状态。

---

## 六、模型接入与降级

解析链：

```text
agents/<id>/settings.json memory.utilityProviderId/utilityModel
→ preferences.json 全局 memory.utilityProviderId/utilityModel
→ Agent 最近一次成功使用的 Provider/模型
→ unavailable：proposal 保持 pending，事件/回想仍可用
```

- Provider/AuthStorage 复用 Phase 2，不在记忆配置写 API Key；
- `deepDiveMode` 默认 `script` 或 `experimental-agent` 由用户显式开启；
- 记忆 Agent 失败、超预算或策略拒绝：保留 sealed batch、运行报告和失败原因，不直接回退为无审批写库；
- 需要兼容时可以使用零 LLM 事件索引和 deterministic candidate stub，但正式事实仍必须经 proposal/approval；
- 预算：`max_iterations`、`max_tokens`、`max_minutes`；超限进入 deferred，不阻塞每日任务。

---

## 七、运行、事务与回滚

- 运行前记录输入 batch IDs、长期库 revision 和 journal watermark；
- 运行中只生成 proposal，不直接改正式表；
- 平台在单个 SQLite 事务内检查 revision、MemoryPolicy、provenance、suppression 和权限后应用；
- `memory_facts`、`memory_journal`、强度变化和 projection revision 同时提交；
- 运行报告写入 `agents/<id>/memory/runs/<ts>/{run.json,REPORT.md}`，不得包含 API Key 或完整敏感原文；
- 回滚通过反向 mutation journal 或事务级 run log，只撤销本次 run 的变更，不恢复整个 memory 目录，避免覆盖并发用户操作；
- 新一轮主 Agent 工作开始后，未提交 proposal 失效或重新校验。

---

## 八、时间线与设置 UI

### 8.1 时间线

时间线展示事件/事实的显著度，不将单纯消息数称为“记忆深度”。**事件无强度列，显著度为派生值（日期近因 + 封顶的独立日期召回数），实时计算不落库；事实展示 retention/activation 双指标。** 信号分为：

```text
retentionStrength：长期固化程度
activationStrength：当前唤起程度
```

检索先按文本/时间相关性，显著度只做同相关度候选的次级排序；recall 使用封顶的独立日期统计，避免“越容易搜到越容易被搜到”的反馈循环。

### 8.2 设置

全局默认和 per-agent 覆盖可配置：

```ts
memory: {
  enabled: true,
  utilityProviderId: string | null,
  utilityModel: string | null,
  deepDiveMode: "script" | "experimental-agent",
  dailyRunTime: "03:00",
  minIdleMinutes: 30,
  weeklyReviewDay: 0,
  weeklyReviewTime: "03:30",
  turnsPerSummary: 10,
  injectBudgetChars: 2500,
  retentionThresholds: { mediumUp: 45, mediumDown: 35, permanentUp: 85 }
}
```

不提供把权重直接调成“永久”的捷径；高级设置可以调整阈值，但仍受 MemoryPolicy 约束。

### 8.3 UI 状态

后台整理不进入主 Agent 的对话消息流，显示为独立状态：

```text
正在整理往事 → 正在核对记忆 → 正在合并相近记忆 → 整理完成 / 整理延期
```

主 Agent 主动调用 `search_memory` 时，使用 RecallEpisode 的“正在努力回想 / 正顺着往事继续寻找 / 想起来了”等状态。

---

## 九、API 与任务拆分

新增 API：

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/agents/:id/memory/deep-dive` | 手动排队一次整理（仍经 MemoryPolicy） |
| POST | `/api/agents/:id/memory/deep-dive/rollback?run=` | 反向 journal mutation 回滚指定 run |
| GET | `/api/agents/:id/memory/runs/:runId` | 读取脱敏运行报告 |
| GET/PUT | `/api/agents/:id/memory/settings` | per-agent 整理与强度设置 |
| GET/PUT | `/api/preferences/memory` | 全局记忆默认读写 |
| GET | `/api/agents/:id/memory/timeline?from=&to=` | 时间线 + 强度双指标 + 分解 |

任务：

```text
T1 契约（主 Agent）：MemoryMutationProposal、settings、strength、run report
   ├─→ T2 记忆 Agent 核心：headless + 白名单 + 只提案不直写 + 预算熔断
   ├─→ T3 MemoryPolicy/事务应用/反向 journal rollback
   ├─→ T4 resolver + 每日空闲/每周调度 + deferred/recovery
   ├─→ T5 强度计算、迟滞、recall ledger 聚合 + 单测
   ├─→ T6 API、运行报告和设置存储
   └─→ T7 时间线 UI + 后台整理状态（依赖 T6）
T8 质量门 + browser-use 验收（主 Agent）
```

测试：`tests/unit/intensity-calculator.test.ts`、`tests/integration/memory-agent.test.ts`（白名单、proposal、策略拒绝、版本冲突、事务回滚、预算熔断）、`tests/integration/memory-scheduler.test.ts`（空闲/日期/每周 gate）、`tests/integration/memory-settings.test.ts`。

---

## 十、验收标准

- [ ] 记忆 Agent 只能读取封存批次和白名单来源，不能 shell/网络/写原文/直写长期表；
- [ ] 每日 03:00 + 空闲 30 分钟 gate 正确；活动时延期，重启按 dirty watermark 恢复；每周复核独立运行；
- [ ] recall ledger 的跨日期、跨 Session 聚合可用；回想本身不直接提升 retention strength；
- [ ] activation 由平台在 recall 命中时确定性更新（独立日期封顶/时间衰减），不经 proposal；`memory_recalls` 是事实来源，`memory_facts.activation_strength` 可由 ledger 重建；retention 只能经提案 + MemoryPolicy 审批；
- [ ] 高优先级用户 intent 在 Session 结束后立即专项处理；长 Session 在 turn 完成后创建 bounded micro-seal（仍经审批，agent 不可用时 pending）；
- [ ] 短期/中期/永久阈值和迟滞正确；永久不自动衰减；pin 不等于强度 100；
- [ ] 中期→永久需要多来源、高可信度、无未解决冲突和 MemoryPolicy 审批；
- [ ] 冲突裁决保留旧事实 `superseded` + `valid_until`，新事实带 provenance；
- [ ] proposal 版本冲突会拒绝或重新计算；正式变更单事务提交；回滚只撤销当前 run；
- [ ] 主 Agent 看不到哪些记忆被遗忘；search_memory 默认排除 forgotten/suppressed；
- [ ] LLM/provider 不可用时 batch pending，不阻塞主 Agent；无未经审批的事实写入；
- [ ] 运行报告完整、脱敏、可读取；后台状态不污染主 Agent 对话流；
- [ ] 时间线分别展示 retention/activation 分解，检索仍以相关性为主；
- [ ] 全部质量门和 browser-use 验收通过。

---

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| 记忆 Agent 漂移或乱写 | 只提案不直写；白名单；provenance 校验；MemoryPolicy；事务和反向 journal |
| recall 反馈循环 | recall 只做 activation 证据；独立日期封顶；不把 memory_recall/injected_memory 当新证据 |
| 后台任务抢占主 Agent | 仅空闲窗口运行；per-agent 串行；活动立即延期 |
| utility 模型不可用 | per-agent → 全局 → 宿主；pending batch + dirty recovery |
| 强度阈值抖动 | 迟滞区间；永久不自动降级；阈值不自动调参 |
| 隐私删除与整理竞态 | 平台 suppression tombstone 优先；proposal 提交前重检 journal watermark |

---

## 实施记录

（实施中回填）

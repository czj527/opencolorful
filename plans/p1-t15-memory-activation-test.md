# P1 T15：记忆激活行为级闭环测试（lane log）

**日期：2026-08-28** · **执行：子 agent（lane `feat/p1-t15-memory-activation-test`）** · 规格：`docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md` §三-4 / §四-3

## 方案

在 `tests/integration/memory-activation.test.ts` 追加 `记忆激活闭环（切片 1.75 T15）` describe，编排 **复盘产出 intent → 每日整理审批 → search_memory 召回** 全链路，并对每一步断言中间态；全部 LLM 调用走 scripted completeText（零真实网络）。

- **场景编排**（`buildClosedLoopScene`）：同一个临时 `OPENCOLORFUL_HOME` + SQLite 上同时挂三个服务——`BackgroundReviewService`（订阅 replayStore turn.completed）、`MemoryAgentResolver`（`deepDiveMode: "experimental-agent"`，内含 runner + MemoryPolicy + ProposalApplication）、`MemoryRecallService`（`depth: "quick"`）。scripted completeText 用**一个共享行队列**依次喂三段输出：复盘 JSON 行 → `propose_fact` 行 → `final` 行；全程断言 `completeText` 恰好被调用 3 次（复盘 1 + 整理 2），是"闭环"的直接证据。
- **驱动入口选择**：调 **`MemoryAgentResolver.runMaintenance`** 而不是 `MemoryAgentScheduler`。scheduler 只负责"何时触发"（每日窗口/空闲 gate/micro-seal），其 gating 已被 `memory-scheduler.test.ts`（mock resolver）覆盖；闭环的核心契约（提取→提案→策略审批→应用→意图结算）全部在 resolver 链上，直接驱动可保持确定性、不模拟时间窗。
- **证据引用**：scripted 提案带 `evidenceRefs: ["session:s1", "batch:b1"]`——`batch:b1` 是预置 sealed 批次（整理候选，记忆 Agent 只读该批次限定会话），`session:s1` 依赖的"回忆账本基线行"沿用 `memory-resolver.test.ts` / `memory-application.test.ts` 的既定模式（MemoryPolicy 要求 session 证据在 ledger 中可验证）。
- **强度断言**：审批时复盘意图仍是 pending 的 remember 意图 → `computeInitialRetention` 的 userIntent 信号触发 → 确定性初始强度 ≥70（与 `memory-application.test.ts` 的用户意图档一致）。
- **第二个用例**：模型提案文本与复盘意图不一致 → 事实照常落地，但原意图**保持 pending 不误结 applied**（settle 按文本精确匹配），批次照常结算。

## 设计修正记录（实施中发现）

1. **文件命名偏差**：`tests/integration/memory-activation.test.ts` 在 main 上**已存在**（Phase 10.5 T5 的 ActivationUpdater/activation 投影测试，commit 8468c0f）。为避免覆盖既有覆盖，T15 测试**追加到同一文件的独立 describe**，而不是新建冲突文件；任务指定路径保持不变。既有 4 个用例未触碰，全部保留。
2. **规格/计划措辞修正**（任务要求，测试落地后同步）：spec §三-4 "次日注入" → "search_memory 可召回（带 provenance/confidence）"，并补"注入只覆盖 memory.md 四段与 pinned、长期事实不自动注入"一句；同时顺带对齐了同文件的另外两处同一错误措辞（§一 背景"自发 remember → 次日注入召回"、§四-3"从 intent 走到注入全绿"）。plan `p1-slice-1.75-memory-activation.en.md` §6-3"Rebuild injection → injected block" → search_memory recall 断言（provenance/confidence 在场）。
3. **中间态完整记录**：审批前 `search_memory` 返回 `empty`（意图未生效不可召回）；审批后同一 query 命中且 `provenance.sessionId="session:s1"`、`confidence=0.95`、`sourceType="memory_recall"`、`strengthTier` 在场；召回后 ledger 出现命中行且 activation 投影 >0（recall 驱动，非审批驱动）。

## 验证证据（逐条单独执行并读退出码）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 ✓（`strict`+`noUncheckedIndexedAccess`+`exactOptionalPropertyTypes`） |
| `npx vitest run tests/integration/memory-activation.test.ts` | 1 文件 6/6 ✓（既有 4 + 新增 2） |
| `npx vitest run tests/integration/memory- tests/unit/memory-` | 21 文件 248/248 ✓（50s，含 memory-resolver 6/6、memory-application 7/7、memory-background-review 8/8） |
| `npm run check:docs` | passed ✓（3 个改动文件，测试型改动默认无需文档治理豁免，已含本文档） |
| `git diff --check` | 无空白错误 ✓ |

## 已知偏差

- **测试不驱动 scheduler**：micro-seal/每日窗口 gating 不在本测试覆盖（已有 scheduler 单测）；本测试直接馈送 sealed 批次给 resolver，等价于调度已触发、候选已封存的状态。
- **session:s1 证据依赖种子基线行**：复盘闭环内尚无真实 recall（召回发生在审批之后），策略的 session 证据校验因此需要预置一条 ledger 基线（同既有集成测试模式），非"零种子"纯行为闭环。
- **strength ≥70 的语义观察**：`computeInitialRetention` 的 userIntent 判定未按 actor 区分，背景复盘意图同样触发 70 档初始强度——本测试将此行为固化为断言（文档化），未改逻辑；若后续意图"低优先不抬强度"，属策略演进，需同步改此断言。
- 未推送、未开 PR；主 agent 将独立复核 diff 并重跑质量门。
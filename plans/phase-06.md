# Phase 6：Token 用量 + 对话时间线 + 会话命令系统 + 开发流程规范化

**状态：已完成（2026-07-25）** | 分支：`phase-6-usage-timeline`
**基线：** `main`（Phase 5b 验收通过后，`e7e09bd`）
**参考：** PI SDK `Usage`/`AgentSession.getSessionStats()`/compaction 事件、openhanako 消息模型与输入交互、主流 Agent 侧边时间线导航

---

## 一、目标

本阶段仍为基础设施完善，不做新 Agent 能力：

1. **Token 用量记录** — 复用 PI SDK 内置 `Usage`，打通"PI 事件 → 平台事件 → 持久化 → API → Web"全链路；Composer 发送按钮左侧用环形组件实时展示上下文占用（悬停查看会话累计与缓存命中率），设置中心查看长期 token 统计与平均缓存命中率；**平台不计算金额**（各模型计价不同）
2. **对话时间线导航** — 聊天区侧边时间线，列出每个对话轮次，点击定位到指定消息
3. **开发文档规范化** — 强化"主 Agent 计划/审查/验收 + 子 Agent 并行探索/开发/回写计划"的协作流程，明确代码质量红线
4. **会话命令系统** — Web 输入框首字符 `/` 触发命令面板，与 TUI 一致的脱离对话命令体验（`/help`、`/compact` 等）；顺带补齐 compact 服务端短板（事件广播、懒重建、忙时拒绝）

---

## 二、PI SDK 能力确认（调研结论）

以下能力已存在于 `@earendil-works/pi-*` 0.80.10，本阶段只做适配，不重复实现：

| 能力 | SDK 位置 | 消费方式 |
|---|---|---|
| `Usage` 类型（input/output/cacheRead/cacheWrite/totalTokens/cost） | `pi-ai` `types.ts` | 适配层提取后映射为平台类型，不直接暴露 |
| usage 事件载体 | `pi-agent-core` `AgentEvent` 的 `message_end`/`turn_end`，`message.usage` | `mapAgentEvent` 提取 |
| 会话累计统计 | `pi-coding-agent` `AgentSession.getSessionStats(): SessionStats`（聚合全部 JSONL entries，含已压缩历史） | 适配层新增只读接口 |
| 上下文占比 | `AgentSession.getContextUsage(): ContextUsage` | 同上 |
| 手动压缩 | `AgentSession.compact(customInstructions?)` | 已接通，补事件与懒重建 |
| 压缩事件 | `AgentSessionEvent` 的 `compaction_start`/`compaction_end`（reason + `CompactionResult`） | 映射为平台事件广播 |
| usage 持久化 | 随 `AssistantMessage` 写入 session JSONL（SDK 自动） | JSONL 仍是正文事实来源；SQLite 只建索引型统计表 |

---

## 三、Token 用量设计

### 3.1 平台契约（`src/contracts/events.ts`）

新增平台用量 Schema（独立于 PI 类型）。**不消费 SDK 的 cost 字段**——各模型/服务商计价不同且随时间变化，平台只统计 token 与缓存指标，避免展示失真金额：

```ts
export const TokenUsageSchema = Type.Object({
  input: Type.Integer({ minimum: 0 }),        // 非缓存输入
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),    // 缓存命中读取
  cacheWrite: Type.Integer({ minimum: 0 }),   // 缓存写入
  totalTokens: Type.Integer({ minimum: 0 }),
});

// 上下文窗口占用（来自 PI getContextUsage()，压缩后 tokens/percent 可为 null）
export const ContextUsageSchema = Type.Object({
  tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  contextWindow: Type.Integer({ minimum: 1 }),
  percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
```

- `turn.completed` 的 payload 把现有预留位收紧并扩展：
  `usage: Type.Optional(TokenUsageSchema)` + `context: Type.Optional(ContextUsageSchema)`
  协议版本不变（向后兼容：旧客户端忽略新字段）
- `context` 随 `turn_end` 由服务端从 runtime 句柄读取并附上，Web 的环形组件无需额外轮询即可实时刷新；压缩后由 `session.compacted` 事件触发重新拉取
- 缓存命中率统一定义（全平台一致）：`命中率 = cacheRead / (input + cacheRead)`，分母为 0 时显示 `—`

### 3.2 事件链打通

1. `src/pi-sdk/types.ts`：`PiAgentEvent` 的 `message_end`/`turn_end` 增加平台 `usage` 字段
2. `src/pi-sdk/agent-session.ts` `mapAgentEvent`：从 PI `AssistantMessage.usage` 提取并映射（faux 路径保持全 0）
3. `src/runtime/event-mapper.ts`：`turn_end` 分支填充 `turn.completed` 的 `usage`
4. 顺序不变：事件先写 Replay Store，再广播 SSE/WS

### 3.3 持久化（Migration v5）

SQLite 新增索引型统计表（属于"平台状态"，不存消息正文，符合数据所有权约束）：

```sql
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_id)   -- 重启重放幂等去重
);
-- 注意：不存 cost 列，平台不计算金额
CREATE INDEX idx_usage_records_created_at ON usage_records(created_at);
```

- 写入点：Runtime 层在处理 `turn.completed`（含 usage）时同步落库，与 Replay Store 同一链路，保证不丢不重
- faux provider 全 0 usage 也记录（测试可断言链路连通）
- 新增 `src/storage/usage-store.ts`，模式对齐 `session-index.ts`

### 3.4 查询 API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/sessions/:id/usage` | 单会话：累计 tokens（分 input/output/cacheRead/cacheWrite）+ 累计缓存命中率 + 上下文占比（重启后从 PI JSONL 经 `getSessionStats()` 等价接口取，不落库也准确） |
| GET | `/api/usage/summary?days=30` | 长期统计：按日聚合、按 provider/model 聚合、加权平均缓存命中率（来自 `usage_records`） |

### 3.5 Web 展示

**环形上下文用量组件（`ContextUsageRing`）**——本阶段的核心可视化：

- 位置：Composer 底行**发送按钮左侧**，SVG 圆环（约 20–24px），随上下文占用比例填充
- 颜色阈值：`<60%` 主题 accent；`60–85%` 警示色；`>85%` 危险色（接近压缩阈值，提示用户可 `/compact`）
- 数据来源：进入会话时调 `/api/sessions/:id/usage` 取基线，之后随 `turn.completed` 事件的 `context` 字段实时更新；`session.compacted` 后重新拉取
- **鼠标悬停**弹出详情卡片：
  - 上下文使用：`已用 tokens / contextWindow`（占比 %）
  - 本次会话累计消耗：input / output / cacheRead / cacheWrite / 总 tokens
  - 本会话缓存命中率
  - `tokens/percent` 为 null 时（刚压缩完）显示"等待下一次响应"
- 无 runtime 数据（空会话）时圆环置灰显示 0%

**assistant 回答卡片**：底部显示本 turn 轻量用量行（`↑in ↓out`，有缓存时追加 `R/W`），数据来自 `turn.completed` 的 `usage`，不显示金额

**设置中心**：新增 `usage` section「用量统计」，只关注 token 与缓存指标：

- 总览卡片：总 tokens（分 input/output/cacheRead/cacheWrite）、加权平均缓存命中率、统计覆盖的会话数与轮次数
- 按日用量表（tokens 与命中率两列）
- 按 provider/model 分布表
- 时间范围切换（7/30/90 天）；不展示任何金额

---

## 四、对话时间线导航设计

### 4.1 交互

- 聊天区右侧一条窄时间线栏（约 48–56px，可展开为带摘要的宽态）
- 每个用户提问轮次一个节点：序号 + 用户消息前 ~20 字摘要 + 相对时间
- 点击节点 → 平滑滚动到对应消息并短暂高亮；当前视口所在轮次节点高亮
- 窄屏（沿用现有断点）自动隐藏，提供开关按钮；偏好持久化到 `preferences.json`（`appearance.timelineVisible`）

### 4.2 实现

- `MessageList` 给用户消息与 assistant 轮次容器加稳定锚点：`data-anchor="turn-<messageId>"`（复用 Phase 5 的真实 message id）
- 新组件 `web/src/features/chat/ChatTimelineNav.tsx`：从 chat state 派生轮次列表（用户消息即轮次起点）
- `use-chat-scroll.ts` 增加 `scrollToAnchor(anchorId)`；滚动监听同步当前节点
- 节点数据不含消息正文之外的敏感信息，纯客户端派生，不改服务端协议

---

## 五、会话命令系统设计

### 5.1 命令集（v1）

| 命令 | 作用 | 执行位置 |
|---|---|---|
| `/help` | 帮助卡片（可用命令清单） | 客户端本地 |
| `/compact` | 压缩当前会话上下文 | API `POST /api/sessions/:id/compact` |
| `/new` | 新建会话 | 客户端本地 |
| `/abort` | 中断当前生成 | 现有 abort 通道 |
| `/clear` | 清空输入框 | 客户端本地 |

带参数命令（`/model <id>`、`/thinking <level>`）不在 v1 范围，后续单独排期。

### 5.2 Web 交互

- `MessageComposer` 输入首字符为 `/` 时弹出命令面板：实时过滤、↑↓ 选择、Enter/Tab 执行、Esc 关闭
- 执行结果以本地系统卡片插入时间线（不进入 PI JSONL，不产生平台事件——`/compact` 除外，见 5.3）
- 命令注册表放 `web/src/features/chat/commands.ts`（名称/描述/可用性/执行函数），TUI 现有 switch 本阶段不动；文档注明后续收敛为共享命令目录

### 5.3 compact 服务端补齐

1. **事件广播**：`compaction_start`/`compaction_end` 映射为平台事件 `session.compacting` / `session.compacted`（payload 含 `tokensBefore`、`tokensAfter` 估算、`summary` 摘要截断），走"先 Replay Store 后广播"标准链路；Web reducer 插入压缩结果卡片（参考 PI TUI 的 CompactionSummaryMessageComponent）
2. **懒重建**：`POST /api/sessions/:id/compact` 在 runtime 缺失时按 messages 路由同款逻辑先重建 runtime，而不是直接 404
3. **忙时拒绝**：会话正在生成时返回 409 `session.busy`
4. **压缩与用量联动**：`session.compacted` 到达后 Web 重新拉取 `/api/sessions/:id/usage` 刷新上下文占比

### 5.4 SSE 同步

`web/src/lib/sse-client.ts` 的 `KNOWN_EVENT_TYPES` 是硬编码白名单，新增 `session.compacting`、`session.compacted`（及可选 `session.usage`）时必须同步，否则 SSE 收不到。这是历史踩坑点，列入验收检查。

---

## 六、开发文档规范化设计

### 6.1 新建 `docs/development.md`（开发流程唯一权威文档）

内容：

- **角色分工矩阵**：
  - 主 Agent：需求澄清、计划编写、任务拆分、子 Agent 协调、diff 审查、独立运行质量门、验收结论、提交与计划回写
  - 子 Agent：定向探索、按任务实现、针对性测试、回报（修改文件/验证命令/结果/未解决问题）
  - 子 Agent 报告**不作为验收证据**，主 Agent 必须独立复核 diff 并重跑验证
- **并行规则**：无共享文件、无共享协议/迁移、无前后依赖才并行；给出本 Phase 的依赖图作为范例
- **任务生命周期**：计划 → RED（关键边界）→ 实现 → 任务级验证 → `npm run check` → 独立提交 → 回写 `plans/phase-xx.md`
- **质量红线**（违反即返工）：
  - `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 必过
  - 关键边界（事件序号/Replay/Abort 竞态/凭据隔离/用量幂等/输入校验）先写失败测试
  - 验证命令单独执行并读退出码，禁止 PowerShell 分号串联
  - Playwright 必须在 `web/` 目录执行
  - 新增 SSE 事件类型必须同步 `KNOWN_EVENT_TYPES`
  - 只有 `src/pi-sdk/` 可 import PI SDK
- **计划模板**：固化 phase-05 式结构（头部字段/设计章节/文件变更清单/任务拆分/质量门/验收 checkbox/实施记录）
- **常见陷阱清单**：PowerShell 退出码、Playwright 目录、SSE 白名单、`apply_patch`、禁用破坏性 git 命令

### 6.2 更新 `AGENTS.md`

- 「开发流程」一节改为摘要 + 指向 `docs/development.md`
- 「当前开发状态」追加 Phase 6 启动记录（实施期间随任务推进回写）

---

## 七、文件变更清单

| 文件 | 动作 | 任务 |
|---|---|---|
| `src/contracts/events.ts` | 修改 — TokenUsageSchema、compaction 事件、turn.completed 收紧 | T1 |
| `src/pi-sdk/types.ts` | 修改 — PiAgentEvent 携带 usage + compaction | T1 |
| `src/pi-sdk/agent-session.ts` | 修改 — mapAgentEvent 提取 usage/compaction 事件、只读统计接口 | T1 |
| `src/runtime/event-mapper.ts` | 修改 — 透传 usage、映射 compaction 事件 | T1 |
| `tests/unit/event-mapper.test.ts`（或新建） | 修改/新建 — usage 与 compaction 事件映射 | T1 |
| `src/storage/migrations.ts` | 修改 — v5 `usage_records` | T2 |
| `src/storage/usage-store.ts` | 新建 — 写入与聚合查询 | T2 |
| `src/server/routes/usage.ts` | 新建 — 两个查询端点 | T2 |
| `src/server/app.ts` / `src/server/start.ts` | 修改 — 挂载路由与装配 | T2 |
| `src/runtime/session-runtime.ts` / `prompt-service.ts` | 修改 — 落库挂钩、统计只读接口、compact 忙时拒绝 | T2/T3 |
| `src/server/routes/messages.ts` | 修改 — compact 懒重建 + 409 busy | T3 |
| `tests/integration/usage-*.test.ts` | 新建 — 落库幂等、统计 API、compact 事件 | T2/T3 |
| `web/src/lib/sse-client.ts` | 修改 — KNOWN_EVENT_TYPES 同步 | T4 |
| `web/src/lib/api-client.ts` | 修改 — usage 查询方法 | T4/T5 |
| `web/src/features/chat/chat-state.ts` | 修改 — usage/context 状态、compaction 卡片、命令本地卡片 | T4/T7 |
| `web/src/features/chat/MessageList.tsx` | 修改 — 锚点、turn 用量行、压缩卡片 | T4/T6/T7 |
| `web/src/features/chat/ContextUsageRing.tsx` | 新建 — 环形上下文用量 + 悬停详情卡片 | T4 |
| `web/src/features/chat/MessageComposer.tsx` | 修改 — 底行挂载圆环（发送按钮左侧，T4）；命令面板交互（T7） | T4/T7 |
| `web/src/features/settings/settings-state.ts` | 修改 — usage section 注册 | T5 |
| `web/src/features/settings/sections/UsageSection.tsx` | 新建 — 用量统计页 | T5 |
| `web/src/features/chat/ChatTimelineNav.tsx` | 新建 — 时间线导航 | T6 |
| `web/src/features/chat/use-chat-scroll.ts` | 修改 — scrollToAnchor、视口同步 | T6 |
| `web/src/components/ChatPane.tsx` | 修改 — 挂载时间线栏与开关 | T6 |
| `src/contracts/preferences.ts` + `src/config/preferences-store.ts` | 修改 — appearance.timelineVisible | T6 |
| `web/src/features/chat/commands.ts` | 新建 — 命令注册表 | T7 |
| `web/tests/e2e/*.spec.ts` | 修改/新建 — 命令、时间线、用量 Playwright 用例 | T9 |
| `docs/development.md` | 新建 — 开发流程权威文档 | T8 |
| `AGENTS.md` / `README.md` | 修改 — 流程摘要链接、Phase 6 状态 | T8/T9 |

---

## 八、任务拆分与依赖

```text
T1 事件契约与适配层（一切基础）
 ├─→ T2 用量持久化与统计 API ─→ T5 设置中心用量页
 ├─→ T3 compact 服务端补齐
 └─→ T4 Web 实时用量展示 ─→ T7 会话命令系统
T6 对话时间线导航（web 独立，待 T4 改完 MessageList 后启动）
T8 开发文档规范化（主 Agent 负责，与 T1 同批启动）
T9 全量验收（最后）
```

### Task 1：事件契约与适配层扩展
- RED 先行：event-mapper 单测断言 `turn.completed` 携带 usage、compaction 事件映射
- `pi-sdk/types.ts`、`pi-sdk/agent-session.ts`、`contracts/events.ts`、`runtime/event-mapper.ts`
- 验证：`npx vitest run tests/unit` + `node scripts/verify-pi-sdk-imports.mjs`

### Task 2：用量持久化与统计 API
- migration v5 + `usage-store.ts` + `routes/usage.ts` + 装配 + Runtime 落库挂钩
- 集成测试：重启重放幂等（UNIQUE 去重）、summary 聚合正确性
- 依赖 T1；与 T3 并行

### Task 3：compact 服务端补齐
- 路由懒重建、busy 409、事件广播链路（T1 已备契约）
- 集成测试：重启后未发消息会话可 compact；生成中 compact 被拒；事件落 Replay Store
- 依赖 T1；与 T2 并行

### Task 4：Web 实时用量展示
- sse-client 白名单、chat-state usage/context 状态、ContextUsageRing（SVG 圆环 + 颜色阈值 + 悬停详情卡）、turn 用量行、Composer 底行集成
- 依赖 T1；改 `MessageList.tsx`/`MessageComposer.tsx`，T6/T7 必须排在其后

### Task 5：设置中心用量统计页
- section 注册 + UsageSection + api-client + 单测
- 依赖 T2

### Task 6：对话时间线导航
- 锚点、ChatTimelineNav、scrollToAnchor、视口同步、偏好持久化、窄屏隐藏
- 依赖 T4（共享 MessageList）；与 T5/T7 可并行（不同文件）

### Task 7：Web 会话命令系统
- commands.ts 注册表、Composer 命令面板、/help /compact /new /abort /clear、压缩卡片渲染
- 依赖 T3（compact 事件）与 T4（共享 Composer）

### Task 8：开发文档规范化
- 新建 `docs/development.md`，更新 `AGENTS.md` 流程节
- 主 Agent 直接负责，不派子 Agent；与 T1 同批启动

### Task 9：全量验收
- 质量门全部通过 + Playwright 补充用例（命令面板、时间线跳转、用量展示）
- 回写本计划实施记录、更新 README/AGENTS 状态、打标签 `phase-6-complete`

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
```

每条单独执行并读取退出码；Playwright 必须在 `web/` 目录执行。

## 十、验收标准

- [x] `turn.completed` 事件携带完整 usage 与 context，SSE/WS 均可收到，重启重放不重复（契约/集成测试 + e2e 用量行）
- [x] 发送按钮左侧圆环实时反映上下文占比，颜色阈值正确；悬停详情展示上下文用量、会话累计 tokens、缓存命中率（e2e 悬停断言）
- [x] assistant 回答卡片显示本 turn 用量行；全平台（事件/API/界面/数据库）不出现金额字段（契约无 cost 字段，usage_records 无 cost 列）
- [x] 设置中心「用量统计」展示按日/按模型聚合、加权平均缓存命中率，时间范围可切换（e2e 聚合断言）
- [x] 时间线导航点击可定位到指定轮次并高亮，窄屏自动隐藏，显隐偏好持久化（e2e 定位/开关断言；锚点失配已修复）
- [x] 输入框首字符 `/` 弹出命令面板，五个 v1 命令全部可用（e2e 面板/过滤/执行断言）
- [x] `/compact` 完成后时间线出现压缩卡片，上下文占比随之刷新（reducer 单测 + compacted 重拉用量）
- [x] 重启后未发消息的会话可 compact；生成中 compact 返回 409（compact-route 集成测试）
- [x] `docs/development.md` 落地，AGENTS.md 流程节同步
- [x] 质量门全部通过；Playwright 23/23（含 6 个新用例）通过
- [x] 工作区干净（`git status --short` 空）

---

## 实施记录

> 实施过程中由主 Agent 回填：提交表、质量门结果、阻断与修复记录、最终验收结论。

### 提交

| 提交 | 内容 |
|---|---|
| `14c4b17` | docs: add phase 6 plan — usage timeline, commands, dev workflow |
| `9338b14` | feat: carry token usage and compaction events through platform event chain（T1） |
| `fcd5025` | feat: emit compaction events on control stream when idle, add PromptService.isBusy（T1 补充 infra） |
| `6b4c5d2` | docs: add development workflow guide and streamline AGENTS.md process section（T8） |
| `6040628` | feat: persist turn token usage to sqlite and expose usage query apis（T2，团队成员实现 + 主 Agent 审查） |
| `ff29942` | feat: compact route lazy rebuild, busy rejection and runtime extraction（T3，团队成员实现 + 主 Agent 审查） |
| `a993c71` | feat: web realtime token usage — context ring, turn usage line, sse event sync（T4，团队成员实现 + 主 Agent 审查） |
| `9677ef0` | feat: settings usage statistics page with daily and per-model breakdown（T5，团队成员实现 + 主 Agent 审查） |
| `468c363` | feat: chat timeline navigation with anchors, scroll sync and visibility preference（T6，团队成员实现 + 主 Agent 审查） |
| `c25271d` | feat: web session command palette with local cards and compaction feedback（T7，团队成员实现 + 主 Agent 审查） |
| `9c11102` | fix: align timeline nav anchors with rendered messages; add phase 6 e2e coverage（T9，主 Agent 修复 + e2e） |

### 质量门

| 检查项 | 结果 |
|---|---|
| `node scripts/verify-pi-sdk-imports.mjs` | 通过 |
| `npx tsc --noEmit -p tsconfig.json` | 通过 |
| `npx vitest run` | 35 测试文件全部通过 |
| `npm run test --workspace=web` | 243 用例全部通过 |
| `npx tsc --noEmit -p web/tsconfig.json` | 通过 |
| `npm run web:build` | 通过 |
| `npx tsc -p tsconfig.build.json` | 通过 |
| `cd web; npx playwright test` | 23/23 通过（含 6 个 Phase 6 新用例） |

### 阻断与修复记录

1. **percent 量纲不一致（T2↔T4 跨契约，主 Agent 审查发现）**：PI `ContextUsage.percent` 为 0–100 刻度，T2 的 `/api/sessions/:id/usage` 返回 0–1 比率，而 T4 的 ContextUsageRing 按 0–100 渲染，基线会缩小 100 倍。修复：路由改为 `(tokens/contextWindow)*100` 并同步测试断言。
2. **SESSION_BUSY 类型强转（T3 审查发现）**：`createApiError("SESSION_BUSY" as never, …)` 绕过类型。修复：`ApiErrorCode` 联合类型正式纳入 `SESSION_BUSY`，移除强转。
3. **团队成员静默停止（流程问题）**：团队模式成员在轮次结束后会静默挂起，mailbox 无新消息。修复：按原名同队重 spawn 即可恢复并继续任务；主 Agent 需主动轮询 git 产出而非空等汇报。
4. **exactOptionalPropertyTypes 违规（T6，主 Agent 独立验证发现）**：成员汇报前未真正运行根 tsconfig，`normalizeAppearance` 把 `boolean \| undefined` 赋给可选非 undefined 字段。修复：`fallback.timelineVisible ?? true`。教训再次印证「子 Agent 报告不作为验收证据」。
5. **时间线锚点失配（T6 集成缺陷，e2e 暴露）**：MessageList 对「JSONL 历史 + 实时消息」做去重合并，已完成轮次改由 `history-<序号>` 合成 id 渲染，而 ChatTimelineNav 仅从实时 `chat.messages` 派生节点，第一轮锚点在 DOM 中不存在，点击无效。修复：新建 `timeline-turns.ts` 共享去重逻辑（`deriveRenderableUserMessages` 与 MessageList 渲染严格同构），ChatPane 以渲染一致的消息序列喂给导航；补 5 个单元用例与 e2e 定位断言。

### 最终验收结论

Phase 6 全部 10 项验收标准达成，质量门 8 项全绿，Playwright 23/23。
功能：token 用量全链路（事件 → SQLite → API → 圆环/用量行/统计页）、对话时间线导航、
Web 会话命令系统（/help /compact /new /abort /clear）、compact 服务端补齐、开发流程文档化。
本 Phase 采用「主 Agent 计划/审查/验收 + 团队成员并行实现」流程，成员产出 5 个任务，
主 Agent 审查独立发现并修复 4 处缺陷（percent 量纲、SESSION_BUSY 强转、
exactOptionalPropertyTypes 违规、时间线锚点失配）。

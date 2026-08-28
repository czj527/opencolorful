# P1 T14：后台复盘服务（lane log）

**日期：2026-08-28** · **执行：主 agent（复杂逻辑按约定不派发）** · 规格：`docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`（D7/D8/D9）

## 方案

hermes `background_review` 轻量版——只取记忆维度，fork 全 agent 改为单次工具型 LLM 调用：

- **新服务** `src/runtime/memory/background-review.ts`：订阅 replayStore `turn.completed` → per-agent 串行 tail（模式同 MemoryTicker）→ 读会话 JSONL 快照（复用 `readSessionBranchSnapshot`/`extractMessageText`）→ 拼"已有记忆节选 + pinned + 最近待处理意图 + 最近对答"→ `completeText(agentId, …)` utility 通道 → 防御式 JSON 解析 → `journalStore.appendIntent`（actor=`background_review`，只产 remember/fact 意图）。整理审批仍归记忆 Agent + MemoryPolicy，本服务不直写长期库。
- **跳过条件**：未绑定助理的会话、归档会话、`enabled=false`、`reviewEnabled=false`、快照不可读；LLM 不可用/输出非 JSON → degraded 静默，主对话无感知。
- **契约**：`MEMORY_JOURNAL_ACTORS` 加 `background_review`；`MemoryAgentSettingsSchema` 加 `reviewEnabled`（默认 true）。
- **存量迁移 两处**：① SQLite CHECK 约束不可 ALTER → schema v13 表重建（建新表/拷贝/换名/重建索引）；② 旧 settings.json 的 memory 子树缺 reviewEnabled 会整树校验失败退默认 → agent-store 读时补默认值并写回（照 v1→v2 迁移模式）。
- **观测**：事件目录注册 `memory.review.started/completed/degraded/failed`（activity 通道，routine；不进 SSE 白名单）。
- **desktop**：`MemoryAgentSettingsView.reviewEnabled` + ipc 映射（缺省 true）+ mock fixture；档案页记忆设置区加"后台复盘" toggle（沿用 enabled 行模式）。

## 设计修正记录（实施中发现）

1. **CHECK 约束教训**：actor 枚举在 DB 层有 CHECK，只改 TS 契约会运行时爆炸（测试当场抓到）——schema v13 迁移补上，契约单测同步改为对 v13。
2. **复盘输入预算**：摘录从旧到新反向填充，超预算丢弃最旧消息；memory.md 快照截断 1500 字符；防重复提案靠提示词携带待处理意图（D9），写入期不做哈希去重。
3. **preferences.json 存量迁移**（全量单测抓到）：`normalizeMemorySettings` 严格校验会让旧偏好文件的 memory 段整段回退默认 → 补"缺 reviewEnabled 先填 true 再校验"的迁移（与 agent-store 同策略），preferences 单测加迁移用例。`tests/integration/supervisor.test.ts` 在全量并行下偶发超时，隔离复跑 21/21 绿——本机 Windows 负载 flake，与本 diff 无关（该文件未被触碰）。

## 验证证据（主 agent 本 lane 独立执行）

- 新增 `tests/integration/memory-background-review.test.ts` 8/8 ✓：intent 落 journal（actor/priority/payload 断言）、空 intents 合法不写、reviewEnabled/enabled 双开关、LLM 不可用降级、非 JSON 降级、未绑定会话跳过、防御式解析丢坏条目
- 记忆+设置相关测试 23 文件 256/256 ✓（含修正后的 v13 契约测试）；preferences 21/21 ✓（含新增 T14 迁移用例）
- `npx tsc --noEmit -p tsconfig.json`（根）✓；desktop tsc ✓；desktop build ✓；`verify-pi-sdk-imports` ✓
- 视觉冒烟（Playwright mock 模式，截图 lane 内未提交）：档案页"后台复盘"开关渲染、默认开、点击翻转
- 全量单测后台运行中（结果 PR 前补充）

## 已知偏差

- 复盘真实触发率与质量需作者日用观察（规格验收 §四-5）；重复提案率若高，再考虑写入期哈希去重（mem0 v3 思路，backlog）。
- 复盘 cost 为每轮一次 utility 调用；追求省钱可在记忆设置里把 utilityModel 指向便宜模型（既有能力，本任务不改）。

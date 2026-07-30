# Phase 10.5：记忆 agent + 时间线 UI + 记忆设置 — 原创层

**状态：规划中** | 分支：`phase-10.5-memory-agent`
**基线：** `main`（Phase 10 验收点，待回填）
**架构权威：** [docs/memory-architecture.md](../docs/memory-architecture.md)
**参考：** hermes-agent `agent/curator.py`（后台 agent + 快照回滚）；openhanako `lib/memory/deep-memory.ts`（被增强的脚本深潜）

> 说明：评测台（多 persona 事实植入 + 断言体系）本期不做，留待后续单独评估；
> 强度信号本期回归，但**只用于时间线 UI 展示与检索排序辅助，不作为遗忘机制**——遗忘仍由传送带折叠承担。

---

## 一、目标

1. **记忆 agent**：深潜加工（事实提取/冲突裁决/合并/长期折叠）从脚本单次 LLM 调用升级为专职后台 agent，可多步查证、解释决策
2. **LLM 接入与设置方案**：记忆 agent 用哪个模型、在哪配、怎么降级——全局默认 + per-agent 覆盖
3. **时间线 UI 图**：`/memory` 升级为横轴时间、纵轴强度的记忆可视化，点击可看强度分解并对记忆做 pin/forget/删除

### 明确不做

- ❌ 评测台（暂缓，后续单独评估）
- ❌ 权重自调节（权重可人工配置，不做自动调参）
- ❌ 强度驱动的遗忘（遗忘仍由传送带折叠 + forget/删除承担）
- ❌ 向量检索、梦境巩固（Phase 12+）

---

## 二、记忆 agent 设计

### 2.1 定位

平台级**内部** agent：独立 headless 会话与系统 prompt，经 PI 适配层驱动，**不出现在用户 Agent 列表、不可被用户对话**。原型：hermes curator（`curator.py:1828` 分叉独立 AIAgent，`quiet_mode=True`、`skip_memory=True`）。

### 2.2 职责（接管并增强 Phase 10 脚本深潜 S5）

| 职责 | Phase 10（脚本） | Phase 10.5（记忆 agent） |
|---|---|---|
| 事实提取 | 脏摘要 → 单次 LLM 提取 | 多步：读摘要 → 存疑处 `read_session_lines` 回查原文 → 落事实，带 provenance |
| 冲突裁决 | 以新覆盖 | 回查原文验证 → 新事实落库 + 旧事实标 `superseded` + `valid_until`（旧识失效不删） |
| 合并去重 | 无 | 同义事实合并，保留更准 provenance |
| 长期折叠质量 | 单次 LLM 折叠 | 折叠前检索已有 longterm，避免重复折叠/信息漂移 |

### 2.3 运行约束

- **工具白名单**：`read_session_lines`（PathGuard 只读）、`search_facts`、`search_events`、`write_fact`、`supersede_fact`、`merge_facts`、`write_longterm`、`report_run`——无 shell、无写原文、无网络
- **预算**：max_iterations / max_tokens / max_minutes 三上限（进配置）
- **输出契约**：结构化结果块（事实/裁决/合并三列表），校验失败修复 1 次；运行报告落 `agents/<id>/memory/runs/<ts>/{run.json,REPORT.md}`
- **快照回滚**：运行前快照 `memory/` 目录 + facts 表导出；异常一键回滚
- **降级**：agent 失败/超预算 → 回退脚本深潜，每日任务不阻塞

### 2.4 触发

- 每日任务 S5 按 `deepDiveMode` 配置走 agent（默认）或 script
- 手动：`POST /api/agents/:id/memory/deep-dive`；回滚：`POST .../deep-dive/rollback?run=`

---

## 三、记忆 agent 的 LLM 接入

### 3.1 模型解析链（优先级从高到低）

```
agents/<id>/settings.json 的 memory.utilityProviderId/utilityModel（per-agent 覆盖）
  → preferences.json 的 memory.utilityProviderId/utilityModel（全局默认）
    → 该 Agent 最近会话使用的 Provider/模型（跟随宿主）
```

- 凭据复用 Phase 2 的 Provider/AuthStorage 体系，**API Key 不落任何记忆配置**
- 解析结果经 `model-service` 创建 headless 会话；解析失败（Provider 被删/无凭据）→ 标记降级，走脚本深潜 → 仍失败走零 LLM 事件索引保底
- 设置中心可配 utility 小模型以控成本（摘要/深潜不需要旗舰模型）

### 3.2 与现有设置的边界

- Provider/凭据管理完全复用设置中心"模型与 Provider"页，**不为记忆单独做凭据 UI**
- 记忆设置只做"用哪个已配置的 Provider/模型"的选择器

---

## 四、记忆设置方案

### 4.1 全局默认（`config/preferences.json` 新增 `memory` 节）

```ts
{
  memory: {
    enabled: true,
    utilityProviderId: string | null,   // null = 跟随宿主会话模型
    utilityModel: string | null,
    deepDiveMode: "agent" | "script",   // 默认 agent
    dailyRunTime: "03:00",              // 每日整理时间（兜底 timer 对齐用）
    turnsPerSummary: 10,
    injectBudgetChars: 2500,
    injectMode: "hot" | "frozen",       // 热更新（默认，照 openhanako）| 冻结快照
    weights: {                          // 强度权重出厂默认（只影响展示/排序）
      duration: 0.25, messageCount: 0.20, toolCalls: 0.20,
      recall: 0.20, pinned: 0.15
    },
    halfLifeDays: 30
  }
}
```

### 4.2 per-agent 覆盖（`agents/<id>/settings.json` 新增 `memory` 节，可缺省）

可覆盖：`enabled` / `utilityProviderId` / `utilityModel` / `deepDiveMode` / `weights` / `halfLifeDays`。缺省字段回退全局默认。

### 4.3 设置中心 UI

- **新"记忆"设置页**（全局）：开关、utility 模型选择器（复用 Provider 下拉）、深潜模式、每日整理时间、注入预算、注入模式、强度权重滑杆组（五个权重 + 半衰期，改动即时生效——强度是查询时算的）
- **Agent 编辑页记忆小节**：覆盖开关 + 与全局相同的字段（留空 = 跟随全局）

---

## 五、强度计算与时间线 API

### 5.1 强度计算（`src/memory/intensity-calculator.ts`，纯函数）

```ts
// 输入信号全部已有：事件列（duration_sec/message_count/tool_calls）
// + recall_count（统计 memory_recalls）+ pinned（查 pinned_memories）
normalized = min(raw / limit, 1.0)             // limits 进配置
raw_intensity = Σ weight_i × normalized_i      // pinned 命中即满分项
effective = raw × 0.5^(days_ago / halfLifeDays)
```

- `now` 作入参注入，可测试；权重/limits/半衰期来自 §4 设置解析结果
- **用途限定**：时间线 UI 展示 + search_events 同层内排序辅助；**不参与遗忘、不参与注入筛选**（注入仍走四段传送带）

### 5.2 API 新增

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/agents/:id/memory/timeline?from=&to=` | 事件 + 强度 + 逐项分解（信号原值/归一化/权重/衰减系数） |
| GET/PUT | `/api/agents/:id/memory/settings` | per-agent 记忆覆盖读写 |
| GET/PUT | `/api/preferences/memory` | 全局记忆默认读写 |

---

## 六、时间线 UI 图（`/memory` 升级，`web/src/features/memory/`）

- **主视图**：横轴时间（日/周/月三档缩放），纵轴强度 0~1；每条事件一个 bar，颜色按类型：事件=蓝 / 事实=橙 / 置顶=红；每日任务运行标记=灰点
- **详情面板**：点击 bar → 摘要、topics、provenance（来源会话链接）、**强度逐项分解**（为什么这条深/浅）、操作（pin / forget / 删除）
- **四段记忆卡片**保留在页面上方（Phase 10 已有）
- `memory.updated` SSE 自动刷新；复用 Phase 7 UI 原语与 tokens

---

## 七、任务拆分

```
T1 契约（主 Agent 串行）：记忆 agent 工具 IO schema、运行报告格式、
   记忆设置 schema（全局/per-agent）、强度计算类型、timeline API 契约
   ├─→ T2 记忆 agent 核心（子 Agent A）：headless 会话、工具白名单、
   │     输出契约校验、预算熔断 + 集成测试
   │     ├─→ T3 快照回滚 + 运行报告（子 Agent A）
   │     └─→ T4 LLM 接入 + 每日任务接入 + 降级回退（主 Agent）：
   │           模型解析链、deepDiveMode、脚本兜底
   ├─→ T5 强度计算 + 设置存储 + API（子 Agent B，依赖 T1）：
   │     intensity-calculator 纯函数 + 单测、preferences/settings 读写、
   │     timeline/settings 路由 + 集成测试
   └─→ T6 时间线 UI（子 Agent C，依赖 T5 契约）：强度图主视图 + 详情面板 +
         设置中心记忆页 + Agent 编辑页记忆小节 + 单测
T7 质量门 + browser-use 验收（主 Agent）
```

测试：`tests/unit/intensity-calculator.test.ts`（归一化/衰减/权重/pinned 满分项）、`tests/integration/memory-agent.test.ts`（白名单越权拒绝/预算熔断/回滚/契约修复/模型解析链降级）、`tests/integration/memory-settings.test.ts`（全局↔覆盖回退）。

---

## 八、质量门

同 Phase 10 全部门。browser-use：时间线 UI 交互（缩放/点击/分解/pin/forget）、设置中心记忆页改权重即时生效、手动 deep-dive 触发与回滚。

---

## 九、验收标准

- [ ] 记忆 agent 只能调白名单工具，越权被拒并留痕
- [ ] 冲突裁决：旧事实 `superseded` + `valid_until`，新事实带 provenance，旧识未删除
- [ ] 运行报告完整；异常运行可回滚；超预算熔断并回退脚本深潜
- [ ] LLM 解析链三级回退正确（per-agent → 全局 → 宿主模型）；无凭据时降级不阻塞每日任务
- [ ] 全局/ per-agent 记忆设置读写正确，缺省字段回退全局
- [ ] 强度计算纯函数正确（含 pinned 满分项、recall_count 接入、半衰期衰减），权重改动即时生效
- [ ] 时间线 UI：横轴时间纵轴强度渲染正确，强度分解可查，pin/forget/删除生效并刷新
- [ ] 强度不参与遗忘与注入筛选（回归：遗忘仍只由传送带/forget/删除触发）
- [ ] 全部质量门通过；browser-use 验收通过

---

## 十、风险与缓解

| 风险 | 缓解 |
|---|---|
| 记忆 agent 漂移（乱写事实） | 白名单无写原文权限；输出契约校验；快照回滚；脚本模式兜底 |
| utility 模型配置错误导致每日任务失败 | 解析链三级回退 + 零 LLM 事件索引保底；健康状态在设置页可见 |
| 权重滑杆被调到极端值 | UI 做归一化提示（权重和自动折算 100%）；强度只影响展示/排序，不伤数据 |
| 时间线大数据量渲染 | API 按日期范围分页；UI 缩放档位控制单页事件量 |

---

## 实施记录

（实施中回填）

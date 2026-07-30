# Phase 10.5：记忆 agent + 记忆评测台 — 原创层与评价体系

**状态：规划中** | 分支：`phase-10.5-memory-agent`
**基线：** `main`（Phase 10 验收点，待回填）
**架构权威：** [docs/memory-architecture.md](../docs/memory-architecture.md) §十
**参考：** hermes-agent `agent/curator.py`（后台 agent 审查模式 + 快照回滚）；openclaw `dreaming-shadow-trial.ts`（晋升前 QA）；openhanako `lib/memory/deep-memory.ts`（被替换的脚本深潜）

---

## 一、目标

Phase 10 用脚本化流水线（照抄 openhanako）立住了记忆底座。Phase 10.5 做两件原创的事：

1. **记忆 agent**：把深潜加工（事实提取/冲突裁决/长期折叠）从"脚本单次 LLM 调用"升级为**专职后台 agent**——它能多步查证、回读原文、解释决策，是 agent "潜意识"的雏形
2. **记忆评测台**：建立可重复的记忆质量评价体系，用数据裁决 Phase 10 留下的三个开放决策（强度信号、注入策略、深潜模式）

### 明确不做

- ❌ 多 Agent 协作基础设施（评测台的 persona 是脚本驱动，不是真 agent，Phase 14 另议）
- ❌ 权重自调节（先有人工实验协议，自调节再议）
- ❌ 向量检索、梦境巩固（Phase 12+）

---

## 二、记忆 agent 设计

### 2.1 定位

平台级**内部** agent：有独立的 headless 会话与系统 prompt，经 PI 适配层直接驱动，**不出现在用户 Agent 列表、不可被用户对话**。原型是 hermes curator（`curator.py:1828` 分叉独立 AIAgent 实例跑审查 prompt，`quiet_mode=True`、`skip_memory=True`）。

### 2.2 职责（接管 Phase 10 脚本深潜 S5 + 增强）

| 职责 | Phase 10（脚本） | Phase 10.5（记忆 agent） |
|---|---|---|
| 事实提取 | 脏摘要 → 单次 LLM 提取 | 可多步：读摘要 → 存疑处 `read_session_lines` 回查原文 → 再落事实，带 provenance |
| 冲突裁决 | 以新覆盖（简单） | 新旧事实冲突时：回查原文验证 → 新事实落库 + 旧事实标 `superseded` + `valid_until`（**旧识失效不删**） |
| 合并去重 | 无 | 同义事实合并，保留更准 provenance |
| 长期折叠质量 | 单次 LLM 折叠 daily→longterm | 折叠前可检索已有 longterm，避免重复折叠/信息漂移 |

### 2.3 运行约束

- **工具白名单**（只能这些）：`read_session_lines`（只读 JSONL，PathGuard 校验）、`search_facts`、`search_events`、`write_fact`、`supersede_fact`、`merge_facts`、`write_longterm`、`report_run`——无 shell、无文件写、无网络
- **预算**：每次运行 max_iterations / max_tokens / max_minutes 三上限（进 memory-config）
- **输出契约**：结构化结果块（事实列表 + 裁决列表 + 合并列表），格式校验失败修复 1 次；运行报告落 `agents/<id>/memory/runs/<timestamp>/{run.json, REPORT.md}`（hermes curator 运行报告同款）
- **快照回滚**：运行前快照 `memory/` 目录 + facts 表导出；运行结果异常时一键回滚（`curator_backup.py` 模式）
- **降级**：记忆 agent 失败/超预算 → 回退 Phase 10 脚本深潜，不阻塞每日任务

### 2.4 触发

- 每日任务 S5 由配置决定走 agent 还是脚本（默认 agent，配置 `memory.deepDiveMode: "agent"|"script"`）
- 手动：`POST /api/agents/:id/memory/deep-dive`
- 回滚：`POST /api/agents/:id/memory/deep-dive/rollback?run=`

---

## 三、记忆评测台设计（tests/eval/，测试基础设施）

### 3.1 定位与形态

**不是多 Agent 系统**。persona 是脚本化对话驱动器（带剧本的 LLM 调用方），通过 Server API 与一个**开启记忆的测试 Agent** 对话，植入代码里写死的事实并记录预期，然后跑确定性断言。

```
tests/eval/
├── personas/
│   ├── tech.project.md        # 技术项目剧本（植入：项目名/技术决策/文件修改）
│   ├── life.daily.md          # 日常生活剧本（植入：日程/偏好/琐事）
│   └── prefs.facts.md         # 偏好事实剧本（植入：明确偏好/禁忌/习惯）
├── planted/                   # 每个剧本对应的预期断言集（代码写死）
│   ├── tech.project.assertions.ts
│   └── ...
├── runner.ts                  # 驱动器：建 agent → 跑剧本 → 触发整理 → 跑断言
├── assertions/                # 断言库（检索/时序/下钻/注入/遗忘）
├── clock.ts                   # 时间模拟（now 注入）
└── reports/<timestamp>.json   # 指标报告
```

### 3.2 剧本格式（半模板化）

剧本 = 写死的事实植入点 + LLM 自然化对话。示例：

```yaml
# personas/tech.project.md（片段）
- plant: "我们的项目叫 OpenColorful，沙箱系统用 PathGuard 四级访问控制"
  expect:
    facts_contain: ["OpenColorful", "PathGuard"]
    recall_queries: ["项目名是什么", "沙箱用什么访问控制"]
- plant: "2026-07-28 我们把 phase-09.md 的验收标准改了"
  expect:
    events_contain: ["验收标准"]
    date_anchor: "2026-07-28"
```

LLM 负责把植入点聊成自然对话（多轮、有干扰话题），**事实与预期是代码常量，不由 LLM 生成**。

### 3.3 断言集（确定性，进质量门）

| 类别 | 断言 | 层 |
|---|---|---|
| 种植召回 | 每个 recall_query 调 search_facts/search_events，Recall@5 = 100% | L1/L2 |
| 时序感知 | "昨天做了什么"→ 含昨日事件；"上周"→ 含对应日期段 | L1/L2 |
| 下钻路径 | 事实只给摘要 → search_events 命中对应事件 → recall_session 返回含原文关键词的行段 | L1→L2→L3 |
| 注入内容 | 整理后 system prompt 快照含预期事实、不含已 forget 内容、不超预算 | L0 |
| 遗忘行为 | forget 后三层检索默认不可见；pinned 不被折叠流程移除 | 全层 |
| 时间模拟 | `clock.advance(7天)` 后：today 段重置、日记归档、强度/分层按规则变化 | 生命周期 |
| 冲突裁决 | 剧本后期植入矛盾事实 → 旧事实标 superseded、新事实可检索、provenance 正确 | 记忆 agent |

### 3.4 参考指标（LLM-judge，不卡门）

- 记忆使用自然度（对话中是否正确运用记忆、有无"我记得"式生硬引用）
- 事实准确率（提取的事实与原文的一致性抽检）

### 3.5 时间与成本

- **时间模拟**：检索/计算路径接受时钟注入（Phase 10 代码预留 now 参数；评测用 `clock` 推进，毫秒级模拟跨天/跨周）
- **成本**：剧本对话用配置的小模型；全套评测设 token 预算上限；CI 只跑快速子集（单剧本 + 核心断言），完整三剧本 nightly/手动 `npm run eval:memory`

---

## 四、决策门（Phase 10.5 核心产出）

评测台跑完三组对比实验，用数据裁决：

| 决策 | 实验 | 裁决依据 | 通过后的动作 |
|---|---|---|---|
| **D1 强度/权重信号** | 纯传送带 vs 传送带+强度排序（raw_signals 已在 P10 schema，实验只加计算层） | Recall@K、时序查询正确率、干扰话题下的信噪比 | 引入强度计算 + 记忆强度图 UI（横轴时间/纵轴强度）；不通过则永久搁置并删除 raw_signals 之外的设计残留 |
| **D2 注入策略** | 热更新 vs 冻结快照（hermes 模式） | 前缀缓存命中率/成本 vs 记忆新鲜度（对话中可用新记忆的轮次延迟） | 定默认值，另一模式进 memory-config 可选 |
| **D3 深潜模式** | 脚本深潜 vs 记忆 agent | 事实准确率、冲突裁决正确率、运行成本 | 定 `deepDiveMode` 默认值 |

实验协议：同一批剧本跑两遍（仅变量不同），断言集与指标对比，结论与数据回填本文"实施记录"。

---

## 五、任务拆分

```
T1 契约（主 Agent 串行）：记忆 agent 工具 IO schema、运行报告格式、
   评测断言集类型、clock 注入点收口（Phase 10 代码审计 + 补 now 参数）
   ├─→ T2 记忆 agent 核心（子 Agent A）：headless 会话驱动、工具白名单、
   │     输出契约校验、预算控制 + 集成测试
   │     ├─→ T3 快照回滚 + 运行报告（子 Agent A）
   │     └─→ T4 每日任务接入 + deepDiveMode 配置 + 降级回退（主 Agent）
   ├─→ T5 评测台（子 Agent B，依赖 T1）：clock、runner、断言库、
   │     三剧本 + 预期断言集 + 报告输出
   └─→ T6 对比实验（主 Agent，依赖 T2-T5）：D1/D2/D3 实验 + 数据回填
         ├─→ T7（条件，D1 通过才做）：强度计算 + /memory 强度图 UI（子 Agent C）
         └─→ T8 质量门 + browser-use 验收（主 Agent）
```

测试：评测台自身即是测试；另需 `tests/integration/memory-agent.test.ts`（白名单越权拒绝/预算熔断/回滚/契约修复）与 `tests/unit/deep-dive-mode.test.ts`。默认 faux provider，禁止真实网络。

---

## 六、质量门

同 Phase 10 全部门，外加：

```powershell
npm run eval:memory -- --fast   # 评测台快速子集（新增 script）
```

browser-use：/memory 页查看记忆 agent 运行报告；一次手动 deep-dive 触发与回滚。

---

## 七、验收标准

- [ ] 记忆 agent 只能调用白名单工具，越权调用被拒并留痕
- [ ] 冲突裁决：矛盾事实植入后旧事实 superseded + valid_until，新事实带 provenance，旧识未删除
- [ ] 运行报告 run.json/REPORT.md 完整；异常运行可一键回滚
- [ ] 记忆 agent 超预算自动熔断并回退脚本深潜，每日任务不阻塞
- [ ] 评测台三剧本可跑，七类确定性断言全部通过并输出 JSON 报告
- [ ] clock 时间模拟可让 7 天后的分层/归档行为在毫秒级完成验证
- [ ] D1/D2/D3 三组实验完成，数据与结论回填本文
- [ ] （D1 通过时）强度图 UI 上线，强度逐项分解可查
- [ ] 全部质量门通过；browser-use 验收通过

---

## 八、风险与缓解

| 风险 | 缓解 |
|---|---|
| 记忆 agent 漂移（乱写事实） | 白名单无写原文权限；输出契约校验；快照回滚；脚本模式兜底 |
| 评测成本失控 | 剧本半模板化 + 小模型 + token 上限 + CI 只跑快速子集 |
| 评测台沦为一次性脚本 | 定位 tests/eval/ 常驻基础设施，断言集随新功能扩充（进开发规范） |
| LLM-judge 不稳定 | 只作参考指标，质量门全用确定性断言 |
| D1 实验指标设计主观 | 实验前先把指标定义写进本文（Recall@K/时序正确率/信噪比的计算方式），评审后再跑 |

---

## 实施记录

（实施中回填：D1/D2/D3 实验数据与结论）

# OpenColorful 基础设施边界与开发决策

> 2026-07-27 | 回答开发前必须明确的 7 类问题：基础设施边界、subagent 特化、记忆系统选型、自我进化难度、日志时机、Electron 时机、开发流程规范
> 配套文档：[positioning-and-roadmap.md](positioning-and-roadmap.md)（核心理念与路线）

## 一、基础设施边界：哪些是所有 agent 都需要的？

**判断原则**：基础设施 = 任何形态的 agent（陪伴朋友 / coding 工程师 / 设计师 / 文档撰写员）都离不开的能力；形态特化 = 仅特定职业形态需要、靠插件/技能包提供的能力。

### 真基础设施（进 core，所有 agent 共享）

| 基础设施 | 说明 | 现状 |
|---|---|---|
| 身份与人格（identity + 底色） | agent 是谁的基底 | ✅ Phase 8：identity/base-color/settings 三文件分离；yuan 模板层后续讨论 |
| 记忆系统（情景/语义/程序三类） | agent 记住一切的基础 | 缺失 |
| 会话生命周期 + 事件总线 + 持久化 | 运行时底座 | ✅ Phase 0-8 |
| 能力/权限声明机制 | agent 能做什么的边界声明（沙箱的"声明层"） | 缺失 |
| 工具调用框架 | agent 行动的执行框架 | ✅ PI 复用 |
| 结构化日志 + 关键行为埋点 | agent 行为可观测 | 待搭 |
| agent 目录结构（即文件夹） | agent 一生的物理载体 | Phase 5 雏形 |

### 形态特化（不进 core，靠插件/技能包）

| 特化能力 | 说明 |
|---|---|
| 沙箱的**具体后端 + 策略** | coding 用 docker/强隔离，陪伴用软限制 |
| plan 编排 | 复杂多步任务 agent 才需要，陪伴朋友不需要 |
| 终端/浏览器/画布/编辑器 | 交互基础设施（形态特化层） |
| 具体工具集 | coding 工具链 vs 文档工具链 vs 设计工具链 |

**关键结论**：很多能力的"机制"是基础设施，"策略/具体实现"是特化。沙箱如此，plan 也如此。

## 二、沙箱属不属于所有 agent 都需要的基础设基础设施？

**是，但要分层理解**：

- **能力声明 + 执行边界机制 = 基础设施**。哪怕陪伴朋友 agent 也要声明"只能读写自己的记忆/案头，不能碰文件系统"——这是 agent 边界的通用机制，所有 agent 都需要。
- **具体沙箱后端 + 策略 = 形态特化**。coding 需要 docker/OS 级强隔离，陪伴只需软限制，文档 agent 中等。

**建议**：Phase 9 做"机制层"（能力声明 + grant-registry + 默认软策略 + 应用层 PathGuard 四级），强后端（docker/serverless）作为特化插件后续加。这样所有 agent 一上线就有边界，coding agent 再叠加强后端。

## 三、plan 编排是不是基础设施？

**不是**。plan 编排是"复杂多步任务"agent 才需要的能力，陪伴朋友/简单对话 agent 不需要。

- **plan 工具**：作为可选 Skill 提供（让 agent 能规划），不进 core
- **多步任务执行框架**：agent loop 已有，平台不额外造
- **临时 Subagent**：Phase 14 提供受控生命周期、上下文委派和结果回传，不等同于 DAG 编排
- **多 agent DAG 编排**：属于 Phase 15+ 的多 Agent 协作，只对需要协作的 Agent 有意义

**结论**：plan 不进 core 基础设施。平台提供执行框架，plan 作为 Skill；Phase 14 只做临时 Subagent，复杂团队编排顺延到 Phase 15+。

## 四、subagent 特化：coding 子智能体与其他子智能体功能不同，怎么特化？

**核心洞察：Phase 14 的 Subagent 是临时、无长期记忆的受控 Agent Runtime。** 它不是新的持久 Agent 身份，也不继承主 Agent 的底色或长期记忆；“特化”来自创建时显式选择的模型、系统任务、Skill、Plugin、工具和权限。

- coding 的“代码审查子 agent” = 临时 Runtime + 代码审查 Skill + 受控文件工具；
- 文档的“校对子 agent” = 临时 Runtime + 校对 Skill + 对应文档工具；
- 平台提供：父子任务契约、生命周期管理、取消/超时、权限快照、日志和结果回传；
- ACP、channel、常驻 Agent 团队和图编排不纳入 Phase 14，顺延到 Phase 15+；
- 具体 Subagent 类型由调用方配置，不在平台中硬编码职业枚举。

这符合“Agent 形态由创建者定义”的理念，同时保持 Phase 14 的基础设施边界：先把单个临时 Subagent 做可靠，再讨论多 Agent 协作。

## 五、记忆系统选型与 OpenColorful 自己的风格

### 主流方案对比（含 openclaw / hermes / openhanako）

| 方案 | 架构 | 强项 | 弱项 | 时序 |
|---|---|---|---|---|
| **Mem0** | 混合向量+图+KV，LLM 提取去重 | 快速上线，社区最大 | 无时序推理 | ❌ |
| **Letta/MemGPT** | OS 分层内存，**自编辑记忆**（memory_replace/insert/rethink） | agent 主动管理记忆，多 agent 协作 | 无时序，上手高 | 部分 |
| **Zep/Graphiti** | 时序知识图谱（情景+语义+社区三层子图） | **事实有有效期**，旧事实失效不删，时序推理强 | 需图谱维护 | ✅ 最强 |
| **A-MEM** | Zettelkasten 卡片笔记，记忆主动生成连接 | 关联推理强 | 研究级 | 部分 |
| **openclaw dreaming** | 三阶段巩固（Light/REM/Deep）+ 六信号评分 + shadow trial | 记忆质量保证，可解释 | 偏巩固机制 | ❌ |
| **hermes** | curator 策展 + learning_graph + FTS5 + Honcho 用户建模 | 融合图谱+全文+用户建模，技能自创 | 复杂 | 部分 |
| **openhanako** | 分层 md(today/week/longterm) + facts.db + ticker | 简单直观 | 被动存储，无质量保证 | ❌ |

业界 2025-2026 收敛于**三类记忆 taxonomy**：情景（episodic，事件带时序）/ 语义（semantic，事实知识）/ 程序（procedural，技能/怎么做）。**没有单一存储范式称王**——向量擅长模糊召回但对关系盲，图谱擅长关系/时序但需本体维护，生产级 agent 越来越用混合架构 + LLM 管理接口。

### OpenColorful 记忆系统：融合 + 自己的风格

**选型**：openhanako 四段传送带 + Hermes FTS5/curator 后台整理 + 时序事实与强度分层；主 Agent 主动回想，记忆 Agent 在空闲窗口提案并由平台审批，融合而非照搬。

**自己的风格——"agent 作息"隐喻 + 中文意象命名**：

把记忆系统和 agent 的"一生/日常"结合，而非冷冰冰的 vector/graph 术语。agent 有白天（交互工作）、有案头（工作台）、有笺（待办），长期记忆在安静窗口由独立记忆 Agent 整理；这借鉴人的有效分层机制，不是表演式模仿。

| OpenColorful 命名 | 对应记忆类型 | 借鉴 | 说明 |
|---|---|---|---|
| **案头** | 工作记忆 + 工作区 | openhanako 书桌 | 当前处理的文件/笺，agent 与用户的异步协作空间 |
| **笺** | 待办/提醒 | openhanako 笺 | 便签，agent 主动读取执行（异步触发） |
| **今日记** | 短期/working | openhanako today.md | 今日交互，快速衰减 |
| **往事** | 情景记忆 episodic | Letta recall + Zep 情景子图 | 会话/事件，带时序，可回溯 |
| **识见** | 语义记忆 semantic | Zep 时序事实 | 事实知识，**带有效期**，旧识失效不删（agent 认知会成长变化） |
| **手艺** | 程序记忆 procedural | hermes learning_graph | 技能/怎么做，可自创改进 |
| **后台整理** | 长期记忆巩固与强度提案 | hermes curator | Session 封存后每日空闲整理、每周复核；proposal 经策略审批 |

这个命名体系是 OpenColorful 的风格——agent 的"一生"意象，而非工程术语。`案头`和`笺`本土化了 openhanako 的书桌概念，`识见`带有效期借鉴 Zep 时序，后台整理借鉴 hermes curator；梦境/三阶段 dreaming 当前不纳入路线，手艺技能自创后移。

### 难度评估

| 能力 | 难度 | 说明 |
|---|---|---|
| 长期记忆后台整理 | 中 | LLM 提取 + 强度提案 + 空闲调度 + 策略审批 |
| 自编辑记忆（Letta 式） | 中 | 工具 + prompt，agent 主动 memory_replace/insert |
| 时序事实（识见 带有效期） | 中高 | 需图谱建模 + 时序失效逻辑 |
| 全文检索（FTS5） | 低 | SQLite FTS5 成熟 |
| 技能自创（手艺） | 高 | 需从经验抽象 + 评估闭环 |
| 学习图谱 | 高 | 图谱建模 + 更新策略 |
| 性格/想法自我演变 | 极高 | 人格一致性风险，易跑偏 |

**建议阶段**：Phase 10 先做四段上下文、往事/识见和主动回想；Phase 10.5 做记忆 Agent、强度和后台整理；Phase 11 做结构化日志；技能系统与手艺后移，梦境暂不考虑。

## 六、agent 成长/自我进化：主流怎么实现，难度大不大？

主流实现路径（由易到难）：
1. **记忆巩固**（后台记忆 Agent）：Session 封存后空闲窗口整理、强度提案和策略审批——中难度
2. **主动回想**：主 Agent 通过 `search_memory` 读取长期记忆，回想命中写入 recall ledger——中难度
3. **技能自创**（hermes curator + learning_mutations）：后续技能系统阶段再评估——高难度
4. **学习图谱**（hermes learning_graph）：知识图谱建模 + 持续更新——高难度
5. **性格/想法演变**：agent 人格随经历变化——极高难度（人格一致性风险，易跑偏成"不像自己"）

**难度总评**：记忆巩固 + 自编辑是"可工程化"的，中难度，建议做。技能自创是"研究级"，高难度，可做但需评估闭环。性格演变风险极高，建议**不做或做强约束**（人格 yuan 作为稳定锚点，只允许"识见/手艺"成长，不允许 yuan 本身漂移）。

**OpenColorful 立场**：agent 的"自我"（yuan 人格）是稳定锚点，成长发生在"识见"（知识增长）和"手艺"（技能增长）层面，人格不漂移。这既是工程务实，也符合"给 agent 完整一生"——一生是经历/认知/技能的成长，而非性格反复无常。

## 七、现在就给系统加全面日志合不合适？

**合适搭框架，不合适做完整分布式 tracing**。

- **现在做**（低成本、高价值）：
  - 统一结构化 logger（级别 + 模块标识 + 结构化字段），复用现有 logging
  - agent 关键行为埋点：工具调用、回想、记忆 Agent 提案/审批、强度变化、subagent 委派和降级恢复
  - 理由：agent 行为可观测是基础设施；后期补埋点很难（散落各处）
- **后续做**（过早优化）：
  - 完整 OpenTelemetry 分布式链路、性能 profiling、采样策略
  - 理由：现在 agent 自我层还在建，链路未稳定，过早 OTel 是负担

**建议**：从 Phase 9-10 起就穿插搭"结构化日志框架 + 关键行为埋点"，Phase 11 再把这些埋点统一收拢为可观测性契约、查询接口和诊断视图。这样既不阻塞前置安全/记忆开发，也不会把日志工作误解为可有可无的旁支。

## 八、现在就做 Electron 桌面端合不合适？

**不合适，现在不做**。

- **理由**：
  - server-first 架构已把 runtime 和 UI 分离，web UI 完全支撑开发
  - Electron 本质是"把 web UI 包成桌面应用 + 主进程能力"，是**产品化打包**，不是核心
  - 现在 agent 自我层（记忆/成长/形态特化）还在建，过早 Electron 会增加打包/构建/IPC 复杂度，拖慢核心
  - openhanako 也是核心稳定后才上的桌面
- **预留**：保证 server/web 接口干净（HTTP/SSE/WS），未来 Electron 主进程只是 thin wrapper + 本地系统能力（文件对话框、托盘、自启动）
- **时机**：生命基础设施层基本完成（约 Phase 10-11）后，作为产品化阶段单独做

**结论**：Phase 8-10 专注 server + web，Electron 留到后期。Phase 8 已按此边界完成，Phase 9-10 继续沿用。web UI 既是开发便利，也是多端形态之一（未来还有 TUI/移动端）。

## 九、开发流程规范合不合理？

现有 `docs/development.md` 相当严谨。评估：

### 合理保留
- **质量门**（tsc strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + vitest + playwright）——这是工程优势，保留
- **契约先行**（TypeBox Schema 先定义再消费）——保留
- **PI 适配层隔离**（verify-pi-sdk-imports.mjs）——保留
- **事件溯源**（先写 replay store 再广播）——保留
- **Phase 模板 + 验收 checkbox**——保留

### 可简化
- **主 Agent / 记忆 Agent 角色分工**：单人 + AI 协作开发时，"主 Agent/子 Agent"话术偏重。实际用 Agent 工具委派即可，无需严格角色流程。建议简化为"开发者 + AI 协作"，保留"AI 报告不作为验收证据，必须独立复核 diff + 重跑质量门"这条铁律
- **Phase 8 步生命周期**（计划→RED→实现→验证→审查→提交→回写→验收）可合并为 5 步：计划 → 实现 → 验证（含审查）→ 提交 → 回写

### 不过度
对于 AI 接续开发，规范严格反而有利（文档化、可回溯、AI 能接续）。不建议大幅放松。

**结论**：规范整体合理，偏严谨但不过度。建议微调：简化角色分工话术，合并 Phase 生命周期步骤，其余保留。

## 十、当前阶段开发节奏建议

### 优先做（生命基础设施层，给 agent 一生铺路）
1. **Phase 8（已完成）** Agent 去类型枚举 + identity/底色/settings 三文件地基
2. **Phase 9（下一阶段）** 沙箱机制层
3. **Phase 10 → 10.5** 记忆系统（四段上下文、主动回想、长期记忆 Agent 整理）——核心
4. **Phase 11（结构化日志）**：Phase 9-10 先埋关键事件，Phase 11 统一日志 Envelope、关联 ID、脱敏、查询和诊断

Phase 8 的最终实现没有提前加入 capabilities、skills、scene、记忆目录或 yuan 持久化引用；底色模板仅初始化创建表单，创建后 Agent 只依赖自身底色数据。

### 暂不做（等自我层稳定）
- Electron 桌面端（Phase 10-11 后产品化阶段）
- 形态特化层（coding/design 专用交互基础设施）——等插件系统（Phase 12）就绪后
- 技能自创（手艺的高阶能力）——后续未排期，待插件/技能系统阶段另行评估
- 性格自我演变——风险极高，建议不做或强约束

### 开发流程
保留质量门和契约，简化角色话术和 Phase 步骤。

---

*本文档为开发前决策依据，与 positioning-and-roadmap.md 配套。具体 Phase 计划（plans/phase-08.md 起）应遵循本文边界。*

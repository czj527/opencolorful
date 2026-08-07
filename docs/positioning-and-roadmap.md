# OpenColorful 项目重新定位与开发路线

> 2026-07-28 | 基于 OpenColorful 现状（Phase 0-8 已验收）与 openhanako(HanaAgent) 深度调研
> 本文回答两个问题：**OpenColorful 到底是什么？后续往哪走？**

## 一、核心理念与定位

### 核心理念：给每个 agent 完整的一生

OpenColorful（开放多彩）不是某个"助理"的实现，而是一套**承载 agent 完整一生的平台基础设施**。

一个 agent 不只是"有用的工具"——它有**自我**（人格、性格、记忆、想法）、有**成长**（从经验学习、自我进化）、有**生活**（书桌、定时任务、主动行为）、有**社交**（与其他 agent 协作、成为朋友）。它的"职业形态"由创建者决定：可以是开发工程师、设计师、文档撰写员、陪伴你的朋友——**平台不预设 agent 是什么，只提供让 agent 成为其想成为的一切的基础设施**。

市面上很多 agent（包括 openhanako）标"助理"标签，更多是因为市场需要 agent "有用"。但 OpenColorful 更关注 agent 的**自我**——性格、记忆、想法。有用性是 agent 自我之上、由创建者通过插件特化的产物，而非平台预设。

### 一句话定位

**OpenColorful = 承载 agent 完整一生的本地优先平台基础设施**：平台提供 agent 的"自我"层（人格 / 记忆 / 成长 / 生活 / 社交），agent 的"职业形态"通过**插件特化的交互基础设施**实现（coding 专用 IDE+终端+浏览器、design 专用画布、文档专用编辑器、陪伴专用对话），由创建者定义而非平台预设。

### 与旧定位的根本区别

| | 旧定位（product.md） | 新理念 |
|---|---|---|
| 核心 | "稳定基础设施，不是某个单一助手" | "承载 agent 完整一生的平台基础设施" |
| agent 是什么 | 平台不定义（但 type 硬枚举三场景） | **由创建者定义**，平台只提供"自我"基础 |
| 关注点 | agent 的"有用性" | agent 的**自我**（性格/记忆/想法/成长） |
| 场景 | 按场景分 Phase（先 coding 再 assistant） | 不预设场景；职业形态通过插件特化 |
| 形态特化 | 技能包（prompt+tools） | **完整交互基础设施**（专用 UI+工具链+工作区），插件提供 |

**根因诊断**：前 7 个 Phase 全在做运行时底座（正确且必要），但 product.md 把"agent 自我层"和"形态特化层"系统性地排除在外，导致做完底座后"想做的 agent 一生"无处落地。Phase 5 的 Agent 身份证是唯一突围，但 `type: "work"|"coding"|"assistant"` 硬枚举**预设了 agent 是什么**——与"agent 形态由创建者定义"的理念冲突。Phase 8 已移除该枚举，并建立身份、底色与运行设置分离的基础模型。

## 二、三层架构目标

OpenColorful 是三层结构。**第一层是 agent 的"自我"，第二层是 agent 的"职业形态"，第三层是 agent 的"一生流转"**。运行时底座已完成，Phase 8 开始建设生命基础设施层：

```
┌─────────────────────────────────────────────────────────┐
│  生态流转层  (待建)                                       │
│  人格模板市场 · 技能包市场 · 角色卡(一生档案) · Bridge    │
│  → agent 的"一生"可流转、可分享、可出现在任何地方         │
├─────────────────────────────────────────────────────────┤
│  形态特化层  (待建，关键难点)                             │
│  插件化的交互基础设施：                                   │
│  · coding 专用工作区(IDE+终端+浏览器+组件选择器)          │
│  · design 专用画布 · 文档专用编辑器 · 陪伴专用对话        │
│  → 真正可用的 X agent ≠ 人格定义，需要专用基础设施        │
├─────────────────────────────────────────────────────────┤
│  Agent 生命基础设施层  (Phase 0-8 部分完成，核心)         │
│  agent 的"自我"：                                         │
│  · 身份与底色(identity/base-color/settings) ✅ Phase 8    │
│  · 记忆与成长（四段上下文 + 主动回想 + 记忆 Agent 整理）      │
│  · 生活与主动性(书桌+定时任务+心跳)                       │
│  · 社交(多agent协作+channel)                              │
│  · 运行时(Server/Session/Provider/Supervisor/UI) ✅       │
│  → 给 agent 完整一生的底座                                │
└─────────────────────────────────────────────────────────┘
```

### 关键洞察：形态特化是完整交互基础设施，不是技能包

这是 OpenColorful 架构的**核心难点**，也是和 openhanako（通用聊天 + 技能包）的根本差异：

- 一个真正可用的 **coding agent** 不只需要"coding 人格"，还需要**终端、浏览器、组件选择器、diff 视图**等专门交互基础设施——通用聊天页面承载不了。codex / trae 都有专门的 coding 交互页面。
- 同理，**design agent** 需要画布与素材面板，**文档 agent** 需要专用编辑器，**陪伴朋友**需要富情感对话界面。
- 所以"形态特化"不是简单的技能包（prompt + tools），而是**完整的交互基础设施**（专用 UI + 工具链 + 工作区），必须通过插件机制提供。
- **平台职责**：提供"可插拔工作区界面"的注册机制，让插件能替换/扩展整个工作区（不只是侧栏 widget），并配套专用工具链与沙箱策略。具体形态（coding IDE、design 画布）作为插件案例实现，不进 core。

## 三、能力差距矩阵（OpenColorful vs openhanako）

| 能力域 | OpenColorful 现状 | openhanako | 差距等级 |
|---|---|---|---|
| 平台层（Server/Session/Provider/Supervisor/UI） | ✅ Phase 0-8 | ✅ server/ + desktop/ | 持平（你更严谨） |
| Agent 身份 | ✅ identity + base-color + settings + 人设注入 | ✅ config.yaml + yuan 引用 | yuan 模板/可分享人格层仍待建 |
| 场景模型 | ✅ Phase 8 已移除 type 枚举 | ✅ 无枚举，技能包组合 | capabilities/skills 组合留后续 Phase |
| 记忆系统 | ❌ 无 | ✅ 分层 md(today/week/longterm) + facts.db + summaries + ticker | 完全缺失 |
| 工具组装 | ⚠️ PI 内置工具三级权限 | ✅ Agent 内部组装 30+ 工具 | 缺 per-agent 工具集 |
| 技能包 skills2set | ❌ 无 | ✅ SKILLS 社区兼容 + 自创 + 安装 | **完全缺失（特化载体）** |
| 插件系统 | ❌ 无 | ✅ 11 类扩展点 + 两级权限 + PluginContext | 完全缺失 |
| 沙箱 | ❌ 无（PI 工具直接动 cwd） | ✅ 双层（PathGuard + OS 级） | **P0 缺口（事故源）** |
| 多 Agent 协作 | ❌ 无 | ✅ channel 群聊 + subagent 委派 | 完全缺失 |
| Bridge 多平台 | ❌ 无 | ✅ Telegram/飞书/QQ/微信 | 完全缺失 |
| 书桌/异步协作 | ❌ 无 | ✅ desk/ + 笺 | 完全缺失 |
| 定时任务 | ❌ 无 | ✅ cron + 心跳巡检 | 完全缺失 |
| 角色卡导入导出 | ❌ 无 | ✅ zip（人格+头像+记忆+skills） | 完全缺失 |

> 综合评分：OpenColorful 平台层扎实，但助理产品层和扩展生态层几乎空白。这正是"定位不清晰"的客观映照——底座有了，上面两层没动。

## 四、核心架构决策

1. **场景模型去枚举化**（Phase 8 已完成地基）
   废弃 `type: "work"|"coding"|"assistant"`，Agent 本身没有类型。Phase 8 不以 capabilities、skills 或 scene 字段替代枚举；能力与技能包组合留到对应后续 Phase。coding/work/design 未来是插件与技能包预设，不是 Agent 类型。

2. **Agent 即文件夹**
   Phase 8 先建立稳定、可迁移的三文件目录；后续能力在明确行为后再扩展，不创建空骨架：
   ```
   ~/.opencolorful/agents/<id>/
   ├── identity.json     ← 最小稳定身份（version/id/name/createdAt）
   ├── base-color.json   ← 底色（persona/personality/replyStyle/innerSetting）
   ├── settings.json     ← 可变运行设置（当前为 defaultCwd）
   └── sessions/         ← PI JSONL 会话
   ```

3. **底色与未来 yuan 模板层分离**
   Phase 8 提供 5 个内置颜色模板，只用于创建时初始化底色；创建后 Agent 不保存模板 ID，也不继续依赖模板。可复用、可分享、可扩展的 yuan 模板层不纳入 Phase 8，待人格与生态需求明确后单独设计。

4. **技能包是场景特化的载体**
   skills2set 机制 → `coding skill bundle` / `work skill bundle` / `design skill bundle`，成组启用。同一 Agent 启用不同 skill bundle 即表现为不同场景能力。

5. **沙箱优先级最高（P0）**
   双层沙箱：应用层 PathGuard 四级访问控制 + OS 级（Windows restricted token 优先）。先于一切新功能——当前 PI coding 工具直接动 cwd，是事故源。

6. **插件系统统一扩展点**
   PluginContext + 两级权限（restricted/full-access）+ capabilities 声明。工具/技能/命令/路由/provider/页面/widget 都走插件，避免散乱的扩展点。

## 五、分阶段开发路线（Phase 8-14，后续能力顺延）

按"奠基 → 安全 → 核心 → 扩展"的依赖顺序：

### Phase 8：Agent 去枚举化 + 底色与新会话体验（已完成，2026-07-28）
- 废弃 type 硬枚举，identity 升级为 version 2；
- `identity.json` / `base-color.json` / `settings.json` 三文件分离，旧 profile 自动迁移；
- 5 个颜色模板只初始化创建表单，Agent 创建后与模板脱钩；
- 独立 Agent 创建/编辑页与新会话创建页；Session 创建时可选绑定 Agent，绑定后不可修改；
- Agent 默认工作目录与 Windows 原生文件夹选择器；首条消息发送时才创建 Session；
- **验收**：旧 Agent 平滑迁移；无 type 可创建并编辑 Agent；底色从下一 turn 生效；新会话草稿不落库且不会重复创建。
- **明确延后**：yuan 持久化引用、capabilities、skills、scene、memory/desk、插件与项目改名。

### Phase 9：沙箱（P0 安全底座）
- 应用层 PathGuard 四级访问控制（read/ controlled-write/ workspace/ full）
- OS 级沙箱（Windows restricted token 优先，macOS Seatbelt / Linux Bubblewrap 后续）
- 工具权限从 PI 三级 → per-agent capability 声明 + grant-registry
- **验收**：coding 工具写入限制在工作目录；越权写入被拒并审计

### Phase 10：记忆系统
- openhanako 四段 Markdown 传送带（today.md / week.md / longterm.md / facts.md，汇编为 memory.md）；这些是自动注入的近期上下文制品，不等同于长期记忆库
- facts.db / memory_events（SQLite 事实与事件索引，复用现有 better-sqlite3）
- summaries/（会话摘要，PI compact 基础上扩展）与 sealed_memory_batch（后台整理输入）
- MemoryTicker（按轮次、水位线和跨日阶段增量编译，不在本阶段调整长期记忆强度）
- `search_memory` 主动回想工具（进入 Agent 工具集，并提供独立回想状态）
- **验收**：Agent 跨会话可通过上下文和主动回想获得事实；四段制品可恢复、可检索；长期记忆不会因上下文滚动被静默改写

### Phase 11：结构化日志与可观测性
- 架构权威与已评审开发计划：[logging-architecture.md](logging-architecture.md) / [phase-11.md](../plans/phase-11.md)；
- 统一结构化日志 Envelope、级别、脱敏与生命周期；
- 记忆链路埋点：回想、sealed batch、调度、proposal、审批、强度变化、降级、恢复；
- Session/Agent/工具/Provider/沙箱事件统一关联 ID；
- 日志查询、健康状态和问题诊断接口；
- **验收**：关键运行链路可追踪，日志不泄露 API Key、Authorization、Cookie 或完整敏感记忆

### Phase 12：通用插件系统（已完成，2026-08-05）
- 原生 Manifest、Protocol、Runtime/Server/UI SDK 与 10 类扩展点；
- Bundle、MCP、Node、Python 四类运行形态及受控权限快照；
- OpenClaw/Hermes 来源兼容、Agent 绑定、开发态循环和 `sdk-showcase`；
- Phase 9 Sandbox 与 Phase 11 Activity/Audit/Trace 全链路接入；
- **验收**：主会话真实模型工具回路、安装/更新/回滚/卸载、日志与 Web E2E 全部通过，详见 `plans/phase-12.md`。

### Phase 13：Skill 系统
- 兼容 Agent Skills、OpenClaw、Hermes、Claude Code、Codex 与 PI 的 Skill 包；
- Skill Catalog、来源/版本/哈希、Bundle、Agent 绑定和每 turn 不可变快照；
- 元数据常驻、正文/支持文件渐进披露，脚本仍走 Phase 9 Sandbox；
- Agent 可在会话中搜索、检查和安装 Skill；风险安装会话内审批；
- Agent 可主动学习，但不得无确认持久停用、解绑或迁移自己的 Skill；
- **验收**：真实 Agent 主会话按需加载 Skill，安装/绑定/风险/日志链路闭环，详见 `plans/phase-13.md`。

### Phase 14：Subagent 1.0
- 临时创建、无长期记忆的子 Agent；
- 可自定义模型、工具、Plugin、Skill 和执行权限；
- 继承父 Session 的任务上下文与工作目录，但不继承主 Agent 的长期记忆；
- 结果回传主 Agent，生命周期、工具调用和权限全量接入日志；
- **不聚焦** channel 群聊、常驻 Agent 团队、ACP 图编排或多 Agent 协作；
- **验收**：主 Agent 能创建、观察、取消临时 Subagent 并接收结构化结果。

### Phase 15+：后续生活与协作基础设施（未排期）
- 多 Agent channel/ACP/图编排；
- Bridge、书桌与笺、cron/心跳、角色卡一生档案；
- Electron Core Browser 和形态特化工作台；
- 技能自创、团队运营等高阶能力需重新评估后单独立项。

## 六、横向参考项目启示

| 项目 | 定位路线 | 对 OpenColorful 启示 |
|---|---|---|
| **openhanako** | 全能助理，可组合不分类 | **主参考**，可组合模型（yuan/skills/plugin/bridge）直接借鉴 |
| oh-my-pi | coding 专精，task subagent 派生其他 | 单场景专精路线的对照（你不走这条） |
| openclaw | ACP 协议子 agent，拒绝 nested planner | Skill 生态与后续 Subagent/多 Agent 协议参考（Phase 13/14+） |
| lobehub | 从聊天进化为多 Agent 平台 | 平台化 + marketplace 路径参考（Phase 12） |
| opencode | Plan/Build 双 agent + git worktree 隔离 | coding 场景的隔离方案参考（Phase 9/11） |
| hermes-agent | 自我改进闭环 + 13 平台 gateway | 记忆巩固、Skill 兼容与后续 Bridge 参考（Phase 10/13/15+） |
| codex | Guardian 审批 + Execpolicy DSL | 沙箱策略 DSL 参考（Phase 9） |

## 七、全方位差异化设计（相对 openhanako）

基于 openclaw / hermes-agent / lobehub 的深度调研，OpenColorful 不做 openhanako 的复制，而是**集四家之长 + 保留自身工程化优势**，形成六大差异化方向。核心理念：**openhanako 是"一个有灵魂的助理"，OpenColorful 要做"一支有灵魂的 AI 团队"——既有人格温度，又有自我进化、团队运营和工程严谨**。

### 方向 1：记忆系统——主动回想 + 后台整理闭环

在 openhanako 稳定四段传送带之上，增加**主动回想 + 后台记忆 Agent 整理**：

- **借鉴 hermes curator 的后台整理**：Session 封存后，在每日空闲窗口运行受限记忆 Agent；每周复核跨会话证据；proposal 经平台策略审批后才改变长期记忆。
- **保留长期记忆强度**：recall ledger 只提供证据，记忆 Agent 负责短期/中期/永久层级、冲突裁决、合并与认知遗忘；技能自创不在当前路线
- **借鉴 hermes FTS5 + Honcho**：跨会话全文检索（FTS5）+ LLM 摘要召回，Honcho 辩证式深度用户建模
- **vs openhanako**：openhanako 仅 today/week/longterm 分层 + facts.db + ticker；OpenColorful 增加两条通道、主动 search_memory、RecallEpisode 和可审计的后台整理
- **落地**：Phase 10（底座）/ Phase 10.5（记忆 Agent）/ Phase 11（日志）

### 方向 2：多 Agent 协作——ACP 协议 + 图运行时

超越 openhanako 的"channel 群聊 + subagent 委派"（扁平但无协议规范）：

- **借鉴 openclaw ACP 协议**：标准化子 agent 通信协议（openclaw 和 hermes 都采纳），而非 ad-hoc channel 调用
- **借鉴 lobehub AgentGraphRuntime**：图式多 Agent 编排（DAG），比 openhanako 扁平 channel 更结构化、可调度
- **借鉴 openclaw 架构原则**：明确拒绝 nested planner（manager-of-managers 嵌套树），坚持扁平协作
- **借鉴 openclaw harness 机制**：coding 场景 **harness 外部 agent**（codex/copilot）而非自造——集成优于重造，OpenColorful 的 coding skill bundle 可 harness 现成 coding agent
- **vs openhanako**：openhanako 是 channel + subagent，无协议规范、无图编排、coding 全自造
- **落地**：Phase 14 先实现临时 Subagent 1.0；channel、ACP 与图运行时顺延到 Phase 15+

### 方向 3：沙箱——多后端可插拔 + serverless

超越 openhanako 的"双层固定沙箱"（PathGuard + 单一 OS 级）：

- **借鉴 openclaw 4 后端 + 三层策略**：docker/ssh/host/browser 后端，sandbox-vs-tool-policy-vs-elevated 三层策略分离（沙箱边界 / 工具策略 / 提权分别管理）
- **借鉴 hermes 6 后端含 serverless**：local/Docker/SSH/Singularity/Modal/Daytona，其中 Modal/Daytona 提供 **serverless 休眠唤醒**（空闲近零成本，按需唤醒）——Agent 可跑在 $5 VPS 或 serverless 上
- **保留 openhanako 双层理念**：应用层 PathGuard 四级 + OS 级，但后端做成可插拔
- **vs openhanako**：openhanako 沙箱后端固定，无 serverless、无多后端选择
- **落地**：Phase 9

### 方向 4：插件系统——bundle/code 二分 + 可替换 memory 槽

超越 openhanako 的"单一插件模型 + 11 类扩展点"：

- **借鉴 openclaw 插件双风格**：bundle-style（**优先**，接口小、稳定、安全边界好，打包 skills/MCP/config）vs code-plugin（深度运行时扩展，hooks/providers/channels/tools）。能 bundle 就不 code
- **借鉴 openclaw Memory 可替换插件槽**：后续将记忆作为特殊插件槽，同一时间一个激活，可替换不同记忆方案（例如简单分层或向量召回）；dreaming 仅作为未来可评估选项，不属于当前路线——记忆实现可演进不锁死
- **借鉴 openclaw Core lean 哲学**：核心精简，能力外置为插件；"如果一个能力还不能做成插件，优先扩展插件 API 而非加 core 行为"
- **借鉴 openclaw ClawHub + lobehub Skill Store**：独立插件/技能市场 + provenance + 安全审查 + 官方发布者机制
- **vs openhanako**：openhanako 单一插件模型，memory 硬编码不可替换，无 bundle/code 区分
- **落地**：Phase 12（插件）/ Phase 13（Skill）

### 方向 5：定位升级——私人 AI 团队运营 + 人格温度

融合 lobehub 运营视角 + openhanako 人格温度：

- **借鉴 lobehub "Chief Agent Operator"**：从单助理升级为"私人 AI 团队运营平台"——hire/schedule/report 多个 Agent，7×24 运营，用户 "stay in charge without staying online"
- **借鉴 lobehub Agent as Unit of Work**：Agent 是工作单元，有任务管理（AgentTaskManager）、调度、汇报——不只是聊天对象，是会干活、会汇报的成员
- **保留 openhanako 人格温度**：每个 Agent 有 yuan 人格，团队不是冷冰冰的 worker 池，而是有"性格"的成员
- **借鉴 lobehub Evolve 愿景**：人机共进化
- **vs openhanako**：openhanako 是"一个有灵魂的助理"；OpenColorful 是"一支有灵魂的 AI 团队"——既有个体人格，又有团队运营
- **落地**：定位层面长期保留；Phase 14 只落地临时 Subagent，团队编排与任务管理顺延到 Phase 15+

### 方向 6：工程化优势（保留并强化）

- **已有优势保留**：TypeBox 契约 + 事件溯源（PlatformEventEnvelope + sequence + replay）+ PI 适配层隔离 + TS strict——比 openhanako（混合 JS/TS + Electron）更工程化
- **借鉴 openclaw doctor 迁移**：配置演进时 `doctor --fix` 检测旧格式、解释、备份、重写——把配置兼容性工程化（openhanako 无此机制）
- **借鉴 openclaw tool-call-repair**：工具调用失败自动修复（独特能力，提升 Agent 鲁棒性）
- **借鉴 hermes agentskills.io 标准**：技能包兼容开放标准，不闭门造技能格式
- **场景预设更明确**：openhanako 偏通用；OpenColorful 提供开箱即用的 coding/work/design 三个 skill bundle 预设，降低配置门槛
- **部署形态更轻**：不强制 Electron，Web/TUI 多端，纯 Node + Hono

## 八、四参考项目能力对比矩阵

| 能力维度 | openhanako | openclaw | hermes-agent | lobehub | OpenColorful 目标 |
|---|---|---|---|---|---|
| 记忆巩固 | ◐ 分层+ticker | ● 后台整理+强度提案 | ● curator+FTS5 | ◐ | ● 回想+记忆 Agent+可审计审批 |
| 多Agent协作 | ◐ channel+subagent | ● ACP协议+拒绝nested | ◐ subagent+RPC | ● GraphRuntime | ● ACP+GraphRuntime |
| 沙箱后端 | ◐ 双层固定 | ● 4后端+三层策略 | ● 6后端含serverless | ○ | ● 多后端可插拔+serverless |
| 插件模型 | ● 11类(单一) | ● bundle/code二分+memory可替换 | ◐ | ● Market+SkillStore | ● bundle/code二分+市场 |
| 自我进化 | ○ | ○ 暂不排期 | ● 闭环(技能自创+改进) | ● SelfIteration | ○ Phase 13 只做 Skill 基础设施，技能自创仍不排期 |
| 团队运营 | ○ | ◐ | ○ | ● Operator+TaskManager | ● 团队运营+人格温度 |
| 人格(yuan) | ● 模板+角色卡 | ○ | ◐ | ◐ | ● yuan模板(主参考) |
| 多平台Bridge | ● 4平台 | ● 28+平台 | ● 5平台 | ○ | ● 选择性接入 |
| 工程严谨 | ◐ 混合JS/TS | ● TS+doctor | ◐ Python | ● Next.js | ● TS strict+契约+适配层 |
| 标准兼容 | ◐ SKILLS | ● MCP双向+ACP | ● agentskills.io | ◐ | ● ACP+agentskills.io+MCP |

> 图例：● 强/原生 ◐ 有/部分 ○ 无。OpenColorful 目标列是"集大成 + 保留工程优势"。

## 九、差异化落地映射（Phase 对应）

| 差异化方向 | 主要落地 Phase | 关键借鉴源 |
|---|---|---|
| 记忆底座 + 主动回想 | Phase 10 | openhanako ticker + Hermes curator 调度思想 + FTS5 |
| 记忆 Agent 整理 + 强度 | Phase 10.5 | Hermes curator 后台 fork + provenance + policy approval |
| 结构化日志 | Phase 11 | 统一 Envelope + 全链路可观测性 |
| Skill 标准兼容 + Bundle + 会话内安装 | Phase 13 | Agent Skills + openhanako + openclaw + hermes |
| 临时 Subagent 1.0 | Phase 14 | openhanako subagent + openclaw 生命周期思想 |
| 多 Agent ACP + 图运行时 | Phase 15+ | openclaw ACP + lobehub GraphRuntime |
| 多后端沙箱 + serverless | Phase 9 | openclaw 4后端 + hermes Modal/Daytona |
| 插件 bundle/code 二分 | Phase 12 | openclaw 插件双风格 + ClawHub |
| 团队运营 + 人格 | Phase 15+ + 定位 | lobehub Operator + openhanako yuan |
| 工程化（doctor/repair/标准） | 贯穿 | openclaw doctor/repair + hermes agentskills.io |

## 十、立即行动建议

1. **Phase 0-13 已完成并验收**：运行时、Agent 底色、沙箱、记忆、日志、插件和 Skill 基础设施已经建立。
2. **进入 Phase 14 临时 Subagent 1.0**：实现无长期记忆的 Thread/Run Runtime、结构化父子协议、主 Agent 纠偏、用户只读观察、权限快照和可靠结果投递，详细草案见 `plans/phase-14.md`。
3. **继续守住阶段边界**：Phase 14 不提前混入 Channel、外部 A2A/ACP、图编排、常驻团队、技能自创或多 Agent 协作。

---

*本文档为定位与路线权威，后续 Phase 计划（plans/phase-08.md 起）应与本文对齐。*

# P1 波次 A：质量体系、两档模型与统一用量

**日期：2026-08-31**  
**状态：已完成（2026-09-05，A0-A9 全部实施合并并验收）**  
**实施计划：** [`plans/p1-quality-model-usage.en.md`](../../../plans/p1-quality-model-usage.en.md)  
**上游路线：** [`docs/positioning-and-roadmap.md`](../../positioning-and-roadmap.md) §五 P1  
**当前状态：** [`docs/project-status.md`](../../project-status.md)

## 一、用户问题

OpenColorful 已有较完整的 Server、PI Runtime、Memory、Subagent、Electron 和 Web 运维基础，但目前还不能用稳定、可重复的方式证明“普通用户从界面完成一条完整工作流”。现有测试主要覆盖服务端、协议和 Web 运维面，Desktop 缺少正式的 Mock UI 测试工程、Electron 真链路测试夹具和持续集成 smoke。此前真实下载体验发现：新建 Agent 后没有工作目录时，首条消息无法创建会话，而且空态错误没有显示。这类问题不能仅靠后端/API 测试发现。

模型选择也尚未形成统一产品语义。当前主会话默认模型、Subagent 默认模型和 Memory utility 模型由不同字段和 fallback 规则控制。用量统计目前主要记录主 Session 成功完成的 turn，Subagent 与 utility/background 调用没有进入统一查询，Desktop 也没有全局用量视图。结果是设置界面可能显示一种配置，后台实际却按照另一套 fallback 调用，用户无法完整解释模型消耗。

## 二、目标

1. 建立覆盖“模块 → 功能 → 详细交互 → 自动化层 → 真实证据”的完整测试资产和执行规范。
2. 对所有已实现的前后端功能进行一次可追踪的全量回归；未实现、跳过和环境阻塞必须显式记录。
3. 建立可重复的 Desktop Mock UI 测试和 Electron 真链路测试，并至少提供稳定的 CI smoke。
4. 固定两档模型语义：`primary` 服务主对话；`secondary` 服务 Subagent、记忆整理、摘要、后台复盘和其他一次性/后台工作。
5. 让模型使用量按来源、角色、模型和关联对象可查，覆盖成功和非成功终态可获得的 token 使用量。
6. 让 Electron 用户可从可见错误关联到可检索的运行日志，而不泄露凭据或敏感正文。

## 三、范围

### 1. 测试体系

测试资产矩阵至少覆盖：onboarding、Agent 身份与档案、workspace、Session 创建、首条消息、聊天流、SSE/WS/replay、Abort、Archive/Rename、Provider/Auth、Settings、Memory、MemoryTicker、Memory Agent、Subagent、Plugin、Skill、Supervisor、Observability、Usage、sandbox/approval、发布/安装/恢复。

每条用例记录：模块、功能、详细交互步骤、用户入口、服务端事实、JSONL/SQLite 真值、预期可见结果、自动化层、证据路径、状态和已知风险。状态使用现有测试约定 `PASS`、`FAIL`、`BLOCKED-ENV`、`SKIP`；它们不能被“CI 全绿”隐式替换。

### 2. 两档模型

- `primary`：主对话默认模型。设置切换影响新建 Session；已有 Session 只有在用户显式修改时切换。
- `secondary`：所有非主对话的一次性或后台工作，至少包括 Subagent、MemoryTicker/rolling summary、Memory Agent、background review、compaction utility 和同类后台调用。
- 两档暂时可以指向同一 Provider/model，但 usage 必须记录不同的 role/source。
- 不在本波次加入第三档模型、复杂动态路由或按任务难度自动混合路由。
- 旧 `subagents.defaultModel`、`memory.utilityModel` 和 per-Agent memory override 的迁移、冲突优先级、兼容保留及诊断必须明确；不能静默丢失配置，也不能让旧 fallback 绕过 canonical policy。
- 没有可用 secondary 时返回稳定、可操作的错误；不得静默借用 primary。

### 3. 统一用量

本波次只纳入 token、cache、context 和调用终态，不计算 cost。至少记录 `source`（main/subagent/utility）、`role`（primary/secondary）、Provider/model、Agent/Session/Thread/Run/Call/correlation 标识、时间、input/output/cache/context token 和 `completed/failed/cancelled/timeout/interrupted/budget_exhausted` 状态。调用正文、prompt、completion、API Key、Authorization、Cookie 不进入 usage 或普通日志。

## 四、非目标

- 不在本波次实现 Web Search、Web Fetch、Browser 或新的第三方渠道。
- 不在本波次实现对话 branch、rollback、timeline tree 或 durable todo；这些进入波次 B 计划。
- 不将五天真实日用作为发现基础缺陷的替代品；五天日用是波次 A/B 完成后的候选验收。
- 不从历史 usage 数据猜测 cost，不引入收费价格数据库。
- 不把 Web 运维客户端升级为产品前端；Desktop 仍是唯一产品前端。
- 不修改 `references/`，不把规划文档当作代码实现证据。

## 五、产品与工程约束

- 只在 `opencolorful/` 内开发；`references/` 只读。
- 只有 `src/pi-sdk/` 可以直接 import `@earendil-works/pi-*`。
- PI JSONL 是消息正文和分支历史事实源；SQLite 只保存索引、事件和平台状态。
- 默认测试使用 PI faux provider 与隔离 `OPENCOLORFUL_HOME`，不得依赖本机真实凭据或真实 Provider 网络。
- 新事件必须先写 Replay Store，再广播；同一 `streamId` 的 sequence 从 1 严格递增。
- 生产代码、契约、持久化、Desktop 和日志变化必须按文档影响矩阵收口。
- 子 Agent 不得扩大 `owns` 范围或自行宣称验收完成；主 Agent 独立复核 diff、命令和真实交互证据。

## 六、验收标准

1. 功能资产矩阵覆盖当前已实现的所有模块和前后端入口，每条记录详细交互和证据位置。
2. Desktop Mock UI 测试能覆盖加载、空态、错误、流式、断线、重试、窄屏和主题等可见状态。
3. Electron 真链路测试能在隔离 home/user-data-dir 中完成启动、Agent 创建、无 cwd 新建 Session、首条消息、SSE、Abort、Reload/Restart、Archive、Rename、Compact、Settings、Provider、Usage 和断线恢复；失败保留截图、trace 和日志。
4. `primary` 与 `secondary` 由同一个 canonical selection policy 选择；主 Session、Subagent、Memory/summary/background review/compaction 没有旧 fallback 绕过。
5. `PreferencesStore` 的 `subagents` 配置可以通过 settings route 写入，关闭重开后仍存在；旧配置迁移和冲突优先级有测试。
6. 主会话、Subagent、utility/background 三类调用的可获得 token 使用量都能进入统一查询；幂等、失败/取消/超时和重启恢复有证据。
7. Desktop 有全局用量入口，能按时间范围、primary/secondary、source、Provider、model、Agent、Session 查询，并有空态、加载和错误状态。
8. 至少一条真实失败路径可以从 UI 错误关联至 IPC、Server、Session/Thread/Run/Call 日志；敏感字段已脱敏。
9. 每条质量命令单独执行并记录退出码；真实 Desktop 交互验收不能由单元测试或 CI 绿替代。

## 七、参考项目与取舍

- OpenHanako：Electron 个人助理体验、模型分工、记忆和可见状态。
- Hermes Agent：辅助模型、后台复盘、工具工作流和可见后台任务。
- OpenClaw：工具策略、审批、审计、主动任务和多来源运行关联。
- CowAgent：Electron watchdog、SSE 回放、scheduler 和全链路可观测性。
- OpenCode / Codex：Plan/todo、会话工作流和工程化测试思路，具体对话能力在波次 B 处理。

本 Feature Spec 只定义目标和产品约束；实现顺序、文件归属、命令和实施记录以英文计划为准。

# OpenColorful 日志系统架构 - 活动、审计与诊断

> 2026-08-01 v1（评审定稿） | Phase 11 架构权威
> 回答一个问题：**OpenColorful 如何完整记录系统活动，同时保持可诊断、可查询、可扩展、默认脱敏，并避免把日志误当成 Agent 记忆或领域事实源。**
> 配套：[positioning-and-roadmap.md](positioning-and-roadmap.md)、[infrastructure-decisions.md](infrastructure-decisions.md)、[memory-architecture.md](memory-architecture.md)、[phase-11.md](../plans/phase-11.md)

## 一、设计原则

1. **一套语义，三条通道**：运行诊断、系统活动和安全审计共享身份与 trace 上下文，但拥有独立 payload、可靠性、存储和保留策略。
2. **语义完整，不复制原始内容**：完整记录状态变化、因果关系、结果、失败、恢复、耗时和资源消耗；不复制完整 Prompt、回复、记忆正文、文件内容和工具原始输入输出。
3. **领域事实源保持独立**：Session JSONL、memory journal/facts、Agent 配置和插件注册表继续是各自权威；日志只引用这些对象，不替代它们。
4. **日志不是记忆**：日志永不自动注入主 Agent 上下文，不自动进入长期记忆，不作为未审批的自我强化证据。
5. **平台拥有身份权威**：eventId、recordedAt、actor、executor、scope、trace 和 producer 由平台生成或重新盖章；插件和外部进程不能伪造。
6. **平台边界自动记录**：模型、工具、沙箱、插件、subagent 和后台任务的开始/终态由平台包装器自动记录；领域模块只补充语义事件。
7. **可靠性按风险分级**：diagnostic 可降级；activity durable-on-accept，完全失败必须显式可见；audit 对高风险操作必须持久化或拒绝执行。
8. **先持久化再广播**：结构化 activity/audit 只有 SQLite commit 后才能进入 operator SSE；spool-only 事件恢复导入前不广播，UI 看到的事件刷新后仍存在。
9. **本地优先与默认私密**：不默认上传任何遥测；查询、导出和清理都在本机完成。
10. **为未来扩展冻结接入面**：插件、subagent、技能、社交、Bridge、浏览器和自动任务统一使用 Observability Port，不建设平行日志系统。

---

## 二、总览图

```text
┌────────────────────────────── 领域事实源 ──────────────────────────────┐
│ Session JSONL      Agent 配置      memory journal/facts      插件注册表 │
│ 对话与工具正文      身份/底色/设置    记忆意志与长期事实          扩展状态  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ 领域操作只产生引用/摘要，不复制正文
                                ▼
┌────────────────────────── 活动生产者与执行边界 ─────────────────────────┐
│ Server / Supervisor / Web / Session / Model / Tool / Sandbox / Memory │
│ Scheduler / future Plugin / future Subagent / Bridge / Worker         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ ObservabilityContext / IPC Port
                                ▼
┌──────────────────────── 平台上下文与契约边界 ───────────────────────────┐
│ AsyncLocalStorage：ownerAgent/session/run/turn/trace/span/operation     │
│ 平台盖章：eventId/recordedAt/actor/executor/scope/producer              │
│ TypeBox 校验 → SafeValue → 脱敏 → 限长/限深 → 速率与权限检查             │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ ObservabilityRouter
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                      ▼
┌──────────────────┐  ┌────────────────────┐  ┌──────────────────────┐
│ diagnostic       │  │ activity           │  │ audit                │
│ 技术细节/stack    │  │ 有意义状态变化      │  │ 权限/审批/高风险修改  │
│ best effort      │  │ durable-on-accept │  │ durable or reject    │
└────────┬─────────┘  └──────────┬─────────┘  └───────────┬──────────┘
         │                       │                        │
         ▼                       ▼                        ▼
每进程独立 JSONL         SQLite activity_events    SQLite audit_events
rotation/dedup/tail      UNIQUE eventId / cursor   append-only Store
         │                       │                        │
         │             ┌─────────┴──────────┐             │
         │             ▼                    ▼             │
         │      DB cursor / SSE       daily metrics       │
         │             │              retention           │
         └─────────────┼────────────────────┼──────────────┘
                       ▼                    ▼
              ┌──────────────────────────────────┐
              │ /logs 工作页与诊断接口           │
              │ 活动/错误/审计/性能/原始日志/导出 │
              └──────────────────────────────────┘

持久化故障：activity/audit → 每进程 emergency spool → 启动幂等导入；导入前不广播
导出链路：已脱敏存储 → 再次脱敏 → privacy manifest → 私有 ZIP/目录
```

---

## 三、现有事件与日志的边界

OpenColorful 已经拥有 Session JSONL、`PlatformEventEnvelope`、Replay Store、SSE/WS、sandbox audit 和 memory event。Phase 11 不把它们混成同一个概念。

| 对象 | 作用 | 是否持久事实源 | 是否包含正文 | 生命周期 |
|---|---|---:|---:|---|
| Session JSONL | 对话、工具和 PI Session 分支经历 | 是 | 是 | Session 生命周期 |
| memory journal/facts | 记忆意志、长期事实和审批结果 | 是 | 是 | Agent 生命周期 |
| `PlatformEventEnvelope` | 实时 UI/协议传输、stream sequence、Replay | 否或局部持久 | 可包含 delta/result | 短期 transport |
| diagnostic | 技术排错与 stack | 否 | 仅脱敏摘要 | 短期 |
| activity | 有意义状态变化和因果链 | 是 | 否 | 分级保留 |
| audit | 权限、审批、安全和关键修改 | 是 | 否 | 默认长期 |

映射原则：

```text
领域动作
  ├─→ 写领域事实源（如 Session JSONL / memory tables）
  ├─→ 写 durable activity/audit
  └─→ 将必要状态投影为 PlatformEventEnvelope 给 UI
```

并非所有 transport event 都进入 activity。例如：

```text
assistant.delta           只在实时流，不持久为 activity
tool.result.delta         只在实时流，不持久为 activity
turn.completed            持久为 activity，并投影到实时流
memory.recall.completed   持久为 activity，并投影到 Agent SSE
sandbox.denied            持久为 activity + audit，并投影到实时流
```

---

## 四、统一事件语义

### 4.1 Envelope 与三类 Payload

```text
ObservabilityEventEnvelope
├── identity：schemaVersion/eventVersion/eventId/eventName/channel
├── time：occurredAt/recordedAt
├── classification：level/status/significance
├── participants：actor/executor/target
├── scope：ownerAgent/session/run/turn/task/tool/plugin
├── trace：trace/span/parent/operation/correlation/links
├── producer：component/process/boot/version
└── payload
    ├── DiagnosticPayload
    ├── ActivityPayload
    └── AuditPayload
```

公共 Envelope 负责回答：

```text
什么时候发生？
谁发起？
谁执行？
影响什么？
属于哪个 Agent/Session/任务？
位于哪条因果链？
由哪个进程和组件记录？
```

Payload 负责回答该通道独有的问题。实现必须使用以 `channel` 为判别字段的 `DiagnosticEventEnvelope | ActivityEventEnvelope | AuditEventEnvelope` 联合类型和对应 TypeBox schema，禁止用一个泛型 payload 加类型断言维持边界。Activity 必须由事件目录分配 significance/status，Audit 必须包含 action/decision/reasonCode。

### 4.2 Actor / Executor / Target / Scope

四者不能合并成模糊的 `source`：

```text
actor     发起者
executor  实际执行者
target    主要影响对象
scope     活动归属范围
```

示例：用户批准记忆 Agent 的强度提案：

```text
actor.kind          = user
executor.kind       = service
executor.id         = memory-policy
target.kind         = memory_fact
target.id           = fact-123
scope.ownerAgentId  = agent-a
scope.taskId        = memory-run-9
```

示例：调度器让记忆 Agent 处理 sealed batch：

```text
actor.kind          = scheduler
executor.kind       = memory_agent
target.kind         = memory_batch
scope.ownerAgentId  = agent-a
```

### 4.3 事件版本

- `schemaVersion` 表示 Envelope 大版本；
- `eventVersion` 表示某个 `eventName` 的 payload 版本；
- 不兼容语义不得在原 version 上静默修改；
- Web 遇到未知 future/plugin event 时使用通用卡片，不崩溃；
- 日志读取器必须能容忍旧字段缺失和未知扩展字段。

### 4.4 平台权威字段

```text
平台生成或覆盖：
eventId / recordedAt / channel / actor / executor / scope / trace / producer

受限调用方可提交：
eventName / occurredAt / status / target / payload

补充约束：
- `channel/level/significance/payload schema/audit mirror` 由代码内置事件目录按 eventName + eventVersion 固定，调用方不可指定；
- `occurredAt` 仅用于展示，`recordedAt` 是平台权威排序键；异常偏移（未来时间或远过去）不拒绝，但标记 `skewed`。
```

插件不能声称自己是 `user`、不能为其他 Agent 填 `ownerAgentId`、不能伪造 `approved` 权限结果。插件自定义事件默认只能是 routine Activity；notable、milestone 和 Audit 必须由平台内置目录或经过 manifest 权限审核与用户授权。

---

## 五、Trace 与生命周期

### 5.1 当前 Turn 内的因果树

```text
trace: turn-42
│
├── span: main-agent
│   ├── span: memory-recall
│   │   ├── facts search
│   │   ├── events search
│   │   └── source lookup
│   │
│   ├── span: model-call-1
│   ├── span: tool-call-read
│   ├── span: model-call-2
│   │
│   └── span: subagent-run-7
│       ├── span: subagent-model
│       └── span: plugin-calendar
│
└── turn.completed
```

同一 Turn 内的同步/短时 subagent 使用相同 trace 和子 span。

### 5.2 独立后台任务

```text
trace: turn-42
└── memory.intent.created
        │
        └── linkedTraceId
             ▼
trace: memory-run-9
├── memory.agent.started
├── memory.batch.processing
├── memory.proposal.created
└── memory.agent.completed
```

后台任务拥有新 trace，避免原 Turn 永久保持 open。`linkedTraceIds` 只用于 Envelope 展示；持久查询必须同步写入 `observability_trace_links(source_trace_id, target_trace_id, relation)`，并为 source/target 建索引。linked graph 查询必须限制深度和节点数、支持反向查找并检测环。

### 5.3 生命周期状态机

```text
                    ┌────────── retrying ──────────┐
                    │                              │
started → processing ─→ completed                  │
   │          │       → degraded                   │
   │          │       → failed ────────────────────┘
   │          ├──────→ cancelled
   │          ├──────→ denied
   │          ├──────→ deferred
   │          └──────→ skipped
   └─ old boot / lost executor ─→ interrupted
```

约束：

- `started` 和终态共享 `operationId`；
- 终态只能提交一次，重复提交幂等返回已有终态；
- `processing` 可更新少量阶段，不作为高频进度流；
- `retrying` 使用相同 operation 或明确新的 attempt span；
- `degraded` 表示保留了可用结果但能力下降，是终态；
- `interrupted` 由启动恢复或执行器退出边界补写；
- duration 使用单调时钟测量，wall clock 只用于展示与排序。

---

## 六、写入、实时与恢复

### 6.1 正常写入

```text
功能调用 ActivityOperation.complete(...)
        │
        ▼
补全 ALS 上下文与平台权威字段
        │
        ▼
事件目录 + TypeBox schema + namespace/permission
        │
        ▼
SafeValue normalize + redact + truncate
        │
        ▼
SQLite commit
        │ success
        ▼
按通道 operator SSE（cursor=表 id）
```

Activity 为 durable-on-accept：Recorder 只有在 SQLite 或 durable spool 成功后才返回 accepted。完全失败必须返回结构化失败并更新 health，不得静默假装记录成功；普通业务默认不因 Activity 失败回滚，Audit 规定的高风险操作除外。所有 durable semantic Activity 直接持久化，不经过未落盘的权威内存 batch；纯内存队列只用于 Diagnostic、重复计数和可重建 metrics。

### 6.2 独立实时 cursor

Observability 不复用 Session/Agent 的 `PlatformEventEnvelope`、连续 sequence、内存 Replay Store 或 Web `KNOWN_EVENT_TYPES`。Activity 与 Audit 各自提供 operator SSE：

```text
/api/observability/activity/stream   Last-Event-ID: <activity table id>
/api/observability/audit/stream      Last-Event-ID: <audit table id>
```

表 id 是单调 cursor，允许因事务回滚、幂等冲突和 retention 产生空洞。重连先以数据库高水位查询 `id > cursor`，再进入 live follow；cursor 早于最小可用 id 或 Audit ledger epoch 变化时发送 reset 控制事件。SQLite commit 后才能广播，spool-only 事件在恢复导入前不能广播。

Health 是直接状态接口，读取 writer、spool、磁盘和失败计数；数据库故障时不能依赖向故障数据库写入 health Activity 来报告自身故障。

### 6.3 Activity/Audit 故障

```text
SQLite 写失败
   │
   ├─ activity → logs/emergency/activity/<process>-<boot>-<segment>.jsonl
   │              ├─ 成功：accepted + health degraded
   │              └─ 失败/超预算：明确失败 + health critical
   │
   └─ audit    → logs/emergency/audit/<process>-<boot>-<segment>.jsonl
                  ├─ 文件/外部操作：成功后才可继续
                  └─ 失败/超预算：高风险操作 fail closed
```

正常由 Server 统一写 Activity/Audit。Server 不可用时，Supervisor 只写自己的 spool；插件和 worker 不得直接打开 Store 或 spool。spool 每进程、每 boot 独立分段，避免 Windows 共享句柄；坏行 quarantine，原 segment 保留。Activity spool 有总预算，Audit spool 不允许静默丢弃，达到上限后高风险操作 fail closed。spool 是恢复介质，不是第四条日志通道。

### 6.4 启动恢复

```text
系统启动
├── 打开日志 Store / migration v8
├── 枚举各进程 spool segment
├── 逐行校验、再次脱敏、坏行 quarantine
├── 按 eventId UNIQUE 幂等导入
├── 检查旧 bootId 的 started/processing operation
├── 根据领域 revision 和执行器状态补 completed/failed/interrupted
├── 运行 retention、FTS 和磁盘预算检查
└── 通过直接 health 接口发布当前状态
```

只有整个 segment 已成功处理后才原子归档/删除；部分失败必须保留原文件与 import cursor。

### 6.5 Audit 与领域事务

```text
同一 metadata.sqlite：领域修改 + audit append 同一事务

文件修改：
durable audit started → temp write/fsync/atomic rename → audit terminal

外部 API：
durable audit/activity started → remote call → terminal
```

同库 Audit 失败时必须回滚领域修改；spool 只能记录失败尝试，不能授权绕开同库事务。fail-closed 清单包括删除、工作区/权限/沙箱策略、记忆审批/遗忘/强度、插件授权、凭据和 audit ledger reset。

Audit 普通写入路径 append-only，不暴露单行 update/delete。显式清理使用 `resetLedger`：单事务递增 `ledger_epoch`、删除旧 epoch，并在新 epoch 插入 `audit.ledger.reset`。v1 的 `previousHash/recordHash` 固定为 NULL，不实现 hash chain。

---

## 七、存储布局

```text
~/.opencolorful/
├── metadata.sqlite
│   ├── activity_events                 【活动】结构化语义记录
│   ├── activity_events_fts             【查询】脱敏短摘要 FTS
│   ├── activity_daily_metrics          【聚合】长期优化趋势
│   ├── audit_events                    【审计】按 ledger epoch append-only
│   ├── observability_trace_links        【因果】跨 trace 双向索引
│   └── observability_state             【恢复】retention/spool/health/ledger epoch
│
├── logs/
│   ├── runtime/
│   │   ├── server/<date>_<boot>_<segment>.jsonl         （info 及以上）
│   │   ├── server/<date>_<boot>_<segment>.debug.jsonl   （trace/debug）
│   │   ├── supervisor/  （同 server 双文件规则）
│   │   └── plugins/<pluginId>/
│   ├── emergency/
│   │   ├── activity/<process>_<boot>_<segment>.jsonl
│   │   ├── audit/<process>_<boot>_<segment>.jsonl
│   │   └── quarantine/
│   └── exports/
│       └── opencolorful-diagnostics-<timestamp>.zip
│
└── agents/<agentId>/
    ├── sessions/*.jsonl                【经历正文，不是日志】
    └── memory/*                        【记忆制品，不是日志】
```

Web 客户端不产生独立日志目录：浏览器错误经受限端点上报后，由 Server 进程盖章并落入 Server 的 Diagnostic 文件。该端点只接受内置 client error schema，校验本机 UI Origin、JSON Content-Type、64KB body 上限和每客户端/全局速率，并忽略客户端提交的全部权威字段。

Phase 11 通过 migration v8 复用 `metadata.sqlite`：semantic Activity 不记录高频 token delta，预期规模可控；同时可让同库领域修改和 Audit 保持事务一致。Observability 偏好通过 `PreferencesDocument` v2 继续存入版本化 `preferences.json`，读取时执行 v1 → v2 归一化迁移，不在 SQLite 建平行 preferences 表。只有真实容量、VACUUM 或查询 P99 证明存在压力后才评估拆出 observability DB。

---

## 八、三条通道

### 8.1 Diagnostic

回答“代码和运行时发生了什么”。

```text
trace/debug/info/warn/error/fatal
component + message + bounded attributes + sanitized Error
```

- 每进程独立文件，避免 Windows 多进程轮转锁；
- 按级别分文件：trace/debug 写 `*.debug.jsonl`，info 及以上写主 JSONL，分级保留（7/30 天）以文件为单位执行，不要求行级清理；
- 连续重复项折叠；
- 有界队列和优先级丢弃；
- logger 自身失败只写 emergency stderr；
- stack 只允许存在于 diagnostic，不进入 activity/audit；
- 当前 Supervisor raw tail 迁移为读取结构化文件并继续支持 cursor/filter。

### 8.2 Activity

回答“系统中有意义的活动是什么、结果如何、属于谁”。

- started/terminal 生命周期；
- Agent/Session/Turn/model/tool/memory/plugin/subagent 作用域；
- duration、attempt、errorCode、metrics；
- `routine/notable/milestone` 分级；
- channel、level、分级、payload schema 和 Audit 镜像由事件目录按 eventName/version 固定，调用方不可指定；
- durable-on-accept：SQLite 或 spool 成功后才返回 accepted，完全失败必须显式暴露；
- 所有 durable semantic Activity 直接落盘，不经过未落盘的权威内存 batch；
- 可查询、可聚合、可实时投影；
- routine 可过期，milestone 默认长期；
- 不保存完整正文。

### 8.3 Audit

回答“谁基于什么策略改变了什么，结果是否允许”。

- 普通写入路径 append-only，显式清理通过 ledger epoch reset；
- action/decision/reasonCode/policyVersion；
- before/after revision 和 changed fields；
- 审批者、权限主体和目标；
- 高风险修改必须可持久化；
- 默认长期保留；
- reset 在单事务内递增 ledger epoch、删除旧 ledger，并在新 ledger 产生 reset 记录；
- Phase 11 v1 只预留 `previousHash/recordHash` 字段，不实现校验链；不冒充本机所有者不可篡改。

---

## 九、未来功能接入

### 9.1 统一入口

```text
Core module / Future extension
        │
        ▼
ObservabilityContext
├── DiagnosticLogger
├── ActivityRecorder
├── AuditRecorder
└── TraceManager
```

核心模块获得完整 `ObservabilityContext`；未来扩展只获得受限 `ExtensionObservabilityPort`，不暴露 `AuditRecorder`。任何扩展不得：

- 直接打开 `metadata.sqlite` 日志表；
- 直接追加平台日志文件或 emergency spool；
- 自填 actor/ownerAgentId/trace/producer；
- 用 diagnostic 代替安全审计；
- 将完整 payload 伪装为 message 写入；
- 默认读取其他 Agent 或平台的原始日志。

### 9.2 Plugin

```text
插件调用请求
   │
   ▼
Plugin Runtime Boundary
├── 平台创建 plugin.execution operation
├── 注入 pluginId/version/ownerAgent/session/trace
├── 捕获 stdout/stderr → diagnostic
├── 权限检查 → audit
├── 插件自定义事件 → namespace/schema/limit
└── 平台自动提交 completed/failed/cancelled
```

插件自定义事件：

```text
plugin.<pluginId>.<domain>.<action>
```

插件 manifest 声明 event name/version/payload schema；自定义事件默认只能是 routine Activity，不能自行注册 notable、milestone 或 Audit。平台拥有最终身份、significance 和权限语义。

AsyncLocalStorage 不跨进程：平台向插件/worker 发放绑定调用实例的只读 trace carrier，返回入口验证 carrier 后重新盖章。扩展自行提交的 actor、ownerAgentId、trace、producer、level 与 significance 一律忽略。

### 9.3 Subagent

```text
主 Agent
   │ subagent.delegated
   ▼
Subagent Runtime Boundary
├── 当前 Turn：继承 trace，创建子 span
├── 后台任务：创建新 trace，写 observability_trace_links
├── ownerAgentId 始终指向永久 Agent
├── 模型/工具/插件调用继续嵌套 span
└── 退出/崩溃自动 terminal 或 interrupted
```

临时 subagent 不是持久 Agent 身份；未来真正的 Agent 间协作则每个 Agent 保留自己的 `ownerAgentId`，委派关系通过 actor/target/trace 表达。`linkedTraceIds` 只做 Envelope 展示，跨后台任务的正反向查询以规范化 trace link 表为准。

### 9.4 其他功能

```text
技能：版本、权限、执行生命周期
自动任务：schedule/trigger/defer/complete/timeout
社交：邀请、连接、委派、投递结果
Bridge：接收、路由、投递、重试，不记录消息正文
浏览器：导航、交互、下载、权限，URL 参数脱敏
成长：提案、验证、接受、拒绝、回滚
```

每个后续 Phase 必须把可观测性契约作为设计与验收的固定章节。

---

## 十、隐私与安全

### 10.1 不进入日志的数据

```text
API Key / Authorization / Cookie / password / private key
完整 Prompt / 回复 / hidden reasoning
完整 memory content
完整文件内容
完整 tool args/result
Provider 原始响应体
大体积 base64/data URL
```

### 10.2 安全摘要

不同领域定义不同摘要：

| 领域 | 可以记录 | 不记录 |
|---|---|---|
| model | provider/model、Token、duration、finish reason | Prompt、回复、原始 body |
| file | operation、规范化/遮蔽路径、bytes、result | 文件内容 |
| bash | rule/pattern、exit code、有限 preview/hash | 完整敏感命令与输出 |
| search | query hash、长度、结果数、duration | 完整敏感 query/result |
| memory | ID/revision/strength/reasonCode | 记忆正文 |
| plugin | pluginId/version/event schema/result kind | 自由形式原始 payload |

### 10.3 双重脱敏

```text
生产者 payload
   → 写入前 allowlist/redact/truncate
   → 已脱敏存储
   → 导出前再次 redact
   → privacy manifest
```

导出不直接复制 auth、Session JSONL、memory.md 或数据库文件。

### 10.4 Agent 与插件读取权限

- 主 Agent 默认没有 `read_logs` 工具；
- 记忆 Agent不能读取 diagnostic/audit；
- 插件默认只能产生事件，不能查询日志；
- 未来若开放日志查询，必须是显式 capability，并默认只能读取自身脱敏事件；
- operator Web 页面与 Agent 工具权限完全分离。

---

## 十一、保留与派生指标

```text
debug diagnostic ───7 天──→ 删除
main diagnostic ───30 天──→ 删除

routine activity ──180 天──→ daily metrics ──长期──→ 优化趋势
notable activity ──2 年────→ 清理/导出
milestone activity ────────→ 长期
audit ─────────────────────→ 默认长期
```

清理前聚合：

- Provider/model 调用、错误、延迟、TTFT、Token；
- 工具成功率、耗时、取消、拒绝；
- sandbox deny 类型；
- recall 命中/empty/深度/耗时；
- memory batch backlog/deferred/failure；
- Session recovery、compaction 和异常中断；
- 后台任务等待与执行时间。

指标是 Activity 的派生投影，不是新的原始事实源。Routine retention 必须在同一事务内执行幂等 metrics UPSERT、retention watermark 和已聚合 Activity 删除；重复运行不得重复计数。Audit 默认长期，显式清理只能通过 ledger epoch reset，并在新 ledger 留下 reset 记录。

Diagnostic 总磁盘预算默认 500MB：超限先删最旧 debug 文件，再删最旧主文件，并暴露 health degraded。Activity spool 默认总预算 128MB，超限后记录失败并 health critical；Audit spool 不静默丢弃，达到上限后高风险操作 fail closed。

隐私删除不级联：Agent 或记忆被隐私删除时，activity/audit 不级联清理——日志只保存 ID、revision 与 reasonCode，不含正文，事实源删除后日志不构成内容副本。

---

## 十二、查询与 UI 投影

```text
SQLite activity/audit + diagnostic file tail
        │
        ▼
Observability Query Service
├── filter/pagination/FTS
├── trace tree + linked causality graph
├── activity/audit 独立 DB cursor SSE
├── error grouping
├── daily metrics
├── direct health/spool/failed/disk/ledger epoch
└── support bundle
        │
        ▼
/logs
├── 活动
├── 错误
├── 安全审计
├── 性能
├── 原始日志
└── 诊断导出
```

UI 只读取经过服务端脱敏和权限过滤的数据；不能直接读取日志文件或 SQLite。分页使用 recordedAt + id 复合 cursor；实时 follow 使用按通道拆分的表 id cursor，允许空洞并处理 retention/ledger reset。Health 直接读取 writer/spool 状态，不依赖 Activity Store 自报故障。

日志工作页是运维/开发工具，设计应安静、密集、便于扫描：稳定表格/时间线、过滤栏、详情面板和 trace 树，不采用营销式 dashboard 或装饰性卡片堆叠。

---

## 十三、Phase 映射

| Phase | 日志关系 |
|---|---|
| Phase 9 | sandbox denial 已有独立 JSONL，Phase 11 迁移到统一 activity + audit |
| Phase 10 | recall、batch、compile、scheduler 事件进入统一 activity |
| Phase 10.5 | memory Agent、proposal、审批、强度和恢复进入 activity + audit |
| **Phase 11** | 统一 Envelope、trace、logger、Store、可靠性、查询、UI、导出和 retention |
| Phase 12 | 插件通过受限 Observability Port 接入，不直写日志 |
| Phase 13 | subagent/多 Agent 通过 actor/executor/ownerAgent/trace 接入 |
| Phase 14+ | Bridge、自动任务、社交和书桌继续复用同一契约 |

---

## 十四、架构不变量

实现和评审必须始终满足：

1. 日志不是 Session 正文、不是记忆、不是领域数据库的替代品；
2. 任何高风险修改都不能只有普通 diagnostic，没有 audit；
3. 任何长任务都不能永久停留在 started/processing；
4. 任何插件/subagent 都不能伪造平台身份和权限决定；
5. 任何实时结构化活动都必须先持久化再广播；
6. 任何日志和诊断包都不能包含凭据、完整 Prompt、完整记忆和文件内容；
7. 任何日志持久化失败都必须可见，不能静默假装成功；
8. 核心功能通过 Observability Context 接入，未来扩展只能使用受限 ExtensionObservabilityPort；
9. 事件 channel/level/significance/schema 必须来自版本化事件目录，调用方不能覆盖；
10. 任何清理必须可预览、可审计；Audit reset 必须递增 ledger epoch 并在新 ledger 留下记录；
11. OpenColorful 默认不向外部服务发送遥测；
12. Operator 实时流必须使用 SQLite commit 后生成的数据库 cursor，不复用 Session 连续 sequence；
13. spool-only 事件在幂等导入 SQLite 前不得广播；
14. 跨后台任务的 trace 关系必须规范化存储并可正反向查询。

---

*本文档是 OpenColorful 日志语义、通道边界、trace、持久化、未来扩展接入和隐私规则的长期架构权威。`plans/phase-11.md` 负责阶段实施范围与验收，不应与本文产生平行定义。*

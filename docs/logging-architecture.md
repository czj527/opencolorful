# OpenColorful 日志系统架构 - 活动、审计与诊断

> 2026-08-01 v1（评审修订） | Phase 11 设计依据
> 回答一个问题：**OpenColorful 如何完整记录系统活动，同时保持可诊断、可查询、可扩展、默认脱敏，并避免把日志误当成 Agent 记忆或领域事实源。**
> 配套：[positioning-and-roadmap.md](positioning-and-roadmap.md)、[infrastructure-decisions.md](infrastructure-decisions.md)、[memory-architecture.md](memory-architecture.md)、[phase-11.md](../plans/phase-11.md)

## 一、设计原则

1. **一套语义，三条通道**：运行诊断、系统活动和安全审计共享身份与 trace 上下文，但拥有独立 payload、可靠性、存储和保留策略。
2. **语义完整，不复制原始内容**：完整记录状态变化、因果关系、结果、失败、恢复、耗时和资源消耗；不复制完整 Prompt、回复、记忆正文、文件内容和工具原始输入输出。
3. **领域事实源保持独立**：Session JSONL、memory journal/facts、Agent 配置和插件注册表继续是各自权威；日志只引用这些对象，不替代它们。
4. **日志不是记忆**：日志永不自动注入主 Agent 上下文，不自动进入长期记忆，不作为未审批的自我强化证据。
5. **平台拥有身份权威**：eventId、recordedAt、actor、executor、scope、trace 和 producer 由平台生成或重新盖章；插件和外部进程不能伪造。
6. **平台边界自动记录**：模型、工具、沙箱、插件、subagent 和后台任务的开始/终态由平台包装器自动记录；领域模块只补充语义事件。
7. **可靠性按风险分级**：diagnostic 可降级，activity 至少一次，audit 对高风险操作必须持久化或拒绝执行。
8. **先持久化再广播**：结构化 activity/audit 提交成功后才进入 Replay Store 与 SSE；UI 看到的事件刷新后仍存在。
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
│ best effort      │  │ at least once      │  │ durable or reject    │
└────────┬─────────┘  └──────────┬─────────┘  └───────────┬──────────┘
         │                       │                        │
         ▼                       ▼                        ▼
每进程独立 JSONL         SQLite activity_events    SQLite audit_events
rotation/dedup/tail      UNIQUE eventId / cursor   append-only Store
         │                       │                        │
         │             ┌─────────┴──────────┐             │
         │             ▼                    ▼             │
         │      Replay Store / SSE    daily metrics       │
         │             │              retention           │
         └─────────────┼────────────────────┼──────────────┘
                       ▼                    ▼
              ┌──────────────────────────────────┐
              │ /logs 工作页与诊断接口           │
              │ 活动/错误/审计/性能/原始日志/导出 │
              └──────────────────────────────────┘

持久化故障：activity/audit → emergency spool → 启动幂等导入
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

Payload 负责回答该通道独有的问题。

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
- `significance` 由事件目录按 eventName 固定，调用方不可指定；
- `occurredAt` 仅用于展示，`recordedAt` 是平台权威排序键；异常偏移（未来时间或远过去）不拒绝，但标记 `skewed`。
```

插件不能声称自己是 `user`、不能为其他 Agent 填 `ownerAgentId`、不能伪造 `approved` 权限结果。

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

后台任务拥有新 trace，避免原 Turn 永久保持 open；`linkedTraceIds` 保存因果来源。

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

## 六、写入、广播与恢复

### 6.1 正常写入

```text
功能调用 ActivityOperation.complete(...)
        │
        ▼
补全 ALS 上下文与平台权威字段
        │
        ▼
TypeBox schema + namespace + permission
        │
        ▼
SafeValue normalize + redact + truncate
        │
        ▼
SQLite transaction / JSONL append
        │ success
        ▼
Replay Store
        │
        ▼
SSE/Web 投影
```

任何结构化 activity/audit 都不能绕过持久化直接广播。

平台级实时事件不属于任何 Session stream：activity 与 audit 各使用一个保留 streamId（如 `platform-observability-activity` / `platform-observability-audit`），sequence 采用对应表自增 id，SSE 与 WS 共享同一 Replay Store；`observability.health.changed` 先落为一条 activity 记录再广播，同样获得持久化 sequence。断线重连由客户端以 SQLite cursor（自增 id）重建，不依赖内存 replay 补间隙。

### 6.2 Activity/Audit 故障

```text
SQLite 写失败
   │
   ├─ activity → emergency/activity-spool.jsonl
   │              ├─ 成功：标 observability degraded，业务可继续
   │              └─ 失败：普通活动告警；关键终态暴露 health failure
   │
   └─ audit    → emergency/audit-spool.jsonl
                  ├─ 成功：保留 durable audit，业务按策略继续
                  └─ 失败：高风险操作 fail closed
```

spool 是临时恢复介质，不是第四条日志通道。

### 6.3 启动恢复

```text
系统启动
├── 打开日志 Store
├── 导入 activity/audit spool（eventId UNIQUE 去重）
├── 检查旧 bootId 的 started/processing operation
├── 根据领域 revision 和执行器状态补 completed/failed/interrupted
├── 运行日志保留与磁盘预算检查
└── 发布 observability health
```

spool 损坏时隔离坏行并保留原文件，不因一行损坏丢弃整个文件。

### 6.4 审计与领域事务

```text
同一 SQLite：领域修改 + audit append 同事务

文件修改：
audit started → temp write → fsync/atomic rename → audit completed

外部 API：
activity started → remote call → completed/failed
```

高风险行为至少包括：删除、权限变更、工作区/沙箱变更、记忆审批/遗忘/强度变化、插件授权、凭据变更和 audit 清理。

---

## 七、存储布局

```text
~/.opencolorful/
├── metadata.sqlite
│   ├── activity_events                 【活动】结构化语义记录
│   ├── activity_events_fts             【查询】脱敏短摘要 FTS
│   ├── activity_daily_metrics          【聚合】长期优化趋势
│   ├── audit_events                    【审计】append-only
│   └── observability_state             【恢复】retention/spool/health cursor
│
├── logs/
│   ├── runtime/
│   │   ├── server/<date>_<boot>_<segment>.jsonl         （info 及以上）
│   │   ├── server/<date>_<boot>_<segment>.debug.jsonl   （trace/debug）
│   │   ├── supervisor/  （同 server 双文件规则）
│   │   └── plugins/<pluginId>/
│   ├── emergency/
│   │   ├── activity-spool.jsonl
│   │   └── audit-spool.jsonl
│   └── exports/
│       └── opencolorful-diagnostics-<timestamp>.zip
│
└── agents/<agentId>/
    ├── sessions/*.jsonl                【经历正文，不是日志】
    └── memory/*                        【记忆制品，不是日志】
```

Web 客户端不产生独立日志目录：浏览器错误经受限端点上报后，由 Server 进程盖章并落入 Server 的 diagnostic 文件。

Phase 11 先复用 `metadata.sqlite`：semantic activity 不记录高频 token delta，预期规模可控；同时可让同库领域修改和 audit 保持事务一致。只有真实容量、VACUUM 或查询数据证明存在压力后才评估拆出 observability DB。

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
- 分级由事件目录按 eventName 固定，调用方不可指定；
- 可查询、可聚合、可实时投影；
- routine 可过期，milestone 默认长期；
- 不保存完整正文。

### 8.3 Audit

回答“谁基于什么策略改变了什么，结果是否允许”。

- append-only Store；
- action/decision/reasonCode/policyVersion；
- before/after revision 和 changed fields；
- 审批者、权限主体和目标；
- 高风险修改必须可持久化；
- 默认长期保留；
- 清理本身产生新的 ledger reset 记录；
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

任何扩展不得：

- 直接打开 `metadata.sqlite` 日志表；
- 直接追加平台日志文件；
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

插件 manifest 声明 payload schema，但平台拥有最终身份和权限语义。

AsyncLocalStorage 不跨进程：插件/worker/IPC 边界必须显式传递 trace 上下文，由平台入口重新盖章。

### 9.3 Subagent

```text
主 Agent
   │ subagent.delegated
   ▼
Subagent Runtime Boundary
├── 当前 Turn：继承 trace，创建子 span
├── 后台任务：创建新 trace，linkedTraceIds 指向来源
├── ownerAgentId 始终指向永久 Agent
├── 模型/工具/插件调用继续嵌套 span
└── 退出/崩溃自动 terminal 或 interrupted
```

临时 subagent 不是持久 Agent 身份；未来真正的 Agent 间协作则每个 Agent 保留自己的 `ownerAgentId`，委派关系通过 actor/target/trace 表达。

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

指标是 activity 的派生投影，不是新的原始事实源。

diagnostic 总磁盘预算默认 500MB：超限先删最旧 debug 文件，再删最旧主文件，并暴露 health degraded。

隐私删除不级联：Agent 或记忆被隐私删除时，activity/audit 不级联清理——日志只保存 ID、revision 与 reasonCode，不含正文，事实源删除后日志不构成内容副本。

---

## 十二、查询与 UI 投影

```text
SQLite activity/audit + diagnostic file tail
        │
        ▼
Observability Query Service
├── filter/pagination/FTS
├── trace tree
├── error grouping
├── daily metrics
├── health/spool/dropped/disk
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

UI 只读取经过服务端脱敏和权限过滤的数据；不能直接读取日志文件或 SQLite。

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
8. 任何未来功能都通过统一 Observability Context 接入；
9. 任何日志清理和审计重置本身都必须留下记录；
10. OpenColorful 默认不向外部服务发送遥测；
11. 平台级实时事件必须使用保留 stream 与持久化分配的 sequence，不得从内存状态发号。

---

*本文档是 OpenColorful 日志语义、通道边界、trace、持久化、未来扩展接入和隐私规则的长期架构权威。`plans/phase-11.md` 负责阶段实施范围与验收，不应与本文产生平行定义。*

# Phase 11：完整日志系统与统一可观测性

**状态：已评审定稿（2026-08-01），待开发** | 建议分支：`phase-11-observability`
**基线：** `main`（Phase 10.5 验收点之后）
**架构权威：** [docs/logging-architecture.md](../docs/logging-architecture.md)
**路线图依据：** [docs/positioning-and-roadmap.md](../docs/positioning-and-roadmap.md) Phase 11
**参考：** openhanako 的 DebugLog / SecurityAuditLog / ActivityHub；Hermes 的集中式多文件 logger、session context 与 Windows 多进程轮转；OpenClaw 的 subsystem logger、diagnostic events、redaction 与 support bundle

> Phase 11 的目标不是把现有 `server.log` 换一种格式，而是建立 OpenColorful 的统一可观测性底座。后续插件、subagent、技能、社交、Bridge 和后台任务都必须通过本阶段冻结的 Observability 契约接入，不得各自建设平行日志系统。

---

## 一、目标

1. 建立统一、版本化、可验证的结构化日志 Envelope，覆盖运行诊断、系统活动和安全审计三条独立通道。
2. 完整记录平台、Agent、Session、Turn、模型、工具、沙箱、记忆和后台任务的有意义状态变化、因果关系、失败恢复与资源消耗。
3. 以 `traceId/spanId/operationId` 串联一次 Turn、模型调用、工具调用、回想、记忆整理和未来 subagent/plugin 执行链路。
4. 建立默认脱敏、字段限额、日志轮转、分级保留、应急落盘和崩溃恢复机制；日志系统故障不能静默破坏高风险审计。
5. 提供结构化查询、实时更新、健康状态、派生优化指标和脱敏诊断包导出。
6. 将当前零散的 `console.*`、`server.log`、Supervisor tail、sandbox `security-audit.jsonl` 和记忆事件收拢到统一契约中。
7. 冻结未来功能的可观测性接入规范：平台边界自动记录，功能内部只补充领域语义事件。

### 用户可感知变化

- “日志与诊断”从单一文本 tail 升级为可筛选的完整工作页面；
- 可按 Agent、Session、时间、模块、事件、状态、错误码和 trace 查询系统活动；
- 可查看一次 Turn 从主 Agent 到模型、工具、回想和后台任务的完整因果链；
- 可单独查看安全审计、失败/降级、性能和原始运行日志；
- 可生成不包含凭据、完整 Prompt、完整记忆正文和工具原始输出的诊断包；
- 可查看日志磁盘占用、保留策略、应急 spool 和日志系统健康状态。

### 明确不做

- 不接入外部云遥测、错误上报或分析服务；所有日志默认仅保存在本机；
- 不在 Phase 11 引入完整 OpenTelemetry Collector、分布式 tracing、Prometheus 或远程导出协议；
- 不记录或导出隐藏 reasoning、完整 Prompt、完整回复、每个 token delta、文件内容或完整工具输入输出；
- 不把日志自动注入 Agent 上下文，不把日志自动转化为长期记忆；
- 不用日志替代 Session JSONL、memory journal、memory facts 或其他领域事实源；
- 不实现插件系统和 subagent 本身，只实现并冻结它们未来必须使用的可观测性接入契约；
- 不宣称安全审计可以对抗拥有本机文件系统权限的用户；本阶段只保证普通写入路径 append-only、数据库完整性检查和明确的 ledger reset 语义；
- 不做 Electron 专属日志能力，保持 Server/Web-first；
- 不实现基于日志的自动调参、自我修复或 Agent 自主读取系统日志。

---

## 二、核心架构决策

### 2.1 一套语义，三条独立通道

| 通道 | 目的 | 权威存储 | 可靠性 | 默认保留 |
|---|---|---|---|---|
| `diagnostic` | 开发排错、堆栈、模块运行细节 | 每进程独立 JSONL | best effort | trace/debug 7 天；info+ 30 天 |
| `activity` | 有意义的系统状态变化与执行历史 | SQLite `activity_events` | durable-on-accept；失败显式可见 | routine 180 天；notable 2 年；milestone 长期 |
| `audit` | 权限、审批、安全和高风险状态修改 | SQLite `audit_events` | durable or reject | 默认长期 |

三条通道共享身份、作用域和 trace 上下文，但 payload 不共用一个无边界对象。

### 2.2 日志是系统证据，不是 Agent 记忆

- Session JSONL 是对话和工具经历正文的权威；
- memory journal / facts / events 是记忆系统权威；
- activity/audit 是系统观察与责任记录；
- diagnostic 是可丢弃的技术排错材料；
- 日志记录可以引用 `sessionEntryId`、`memoryId`、`batchId`，但不复制对应正文；
- 未来记忆 Agent 若使用某条活动记录，必须经过显式适配和来源标记，Phase 11 不自动接通。

### 2.3 “完整”的定义

完整记录的是：

```text
关键状态变化 + 因果关系 + 结果 + 错误 + 重试 + 耗时 + 资源消耗
```

不是：

```text
复制所有原始内容 + 每个 token chunk + 每个 HTTP 200 + 每次健康检查成功
```

任何长时间、可失败、可取消、修改状态或消耗重要资源的操作，都必须有 `started` 和一个终态。

### 2.4 平台自动埋点 + 领域语义事件

- 平台边界自动产生执行开始、完成、失败、取消、拒绝、超时和进程退出事件；
- 功能模块只补充自己的领域事件；
- 完整性不能依赖插件作者或后续开发者“记得写日志”；
- 后续功能不得直接写日志文件、直接访问日志表或伪造平台身份字段。

---

## 三、统一事件契约

### 3.1 Envelope

```ts
interface ObservabilityEventEnvelope<TPayload> {
  schemaVersion: 1;
  eventVersion: number;

  eventId: string;
  eventName: string;
  channel: "diagnostic" | "activity" | "audit";

  occurredAt: string;
  recordedAt: string;

  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  status?: ActivityStatus;
  significance?: "routine" | "notable" | "milestone";

  actor: ActorRef;
  executor: ExecutorRef;
  target?: ResourceRef;
  scope: EventScope;
  trace: TraceContext;
  producer: ProducerContext;

  payload: TPayload;
}
```

`eventId` 每条记录唯一。同一操作产生的 diagnostic/activity/audit 记录通过相同的 `traceId`、`spanId`、`operationId` 或 `correlationId` 关联，不复用 `eventId`。

上述接口仅表达公共字段；实际 TypeScript 与 TypeBox 契约必须实现为以 `channel` 为判别字段的联合类型：`DiagnosticEventEnvelope | ActivityEventEnvelope | AuditEventEnvelope`。Activity 必须包含目录分配的 `significance` 与生命周期 `status`（无生命周期的单点 Activity 使用 `completed`）；Diagnostic 禁止携带 Audit payload；Audit 必须包含 `action/decision/reasonCode`。不得依靠业务调用方的类型断言维持三条通道边界。

### 3.2 生命周期状态

```text
started | processing | completed | degraded | failed | cancelled
denied | deferred | retrying | skipped | interrupted
```

终态：

```text
completed | degraded | failed | cancelled | denied | skipped | interrupted
```

约束：

- 一个 `operationId` 只能有一个 `started` 和一个最终终态；
- `retrying` 必须携带 `attempt` 和 `nextRetryAt` 或退避信息；
- 启动恢复负责把旧 `bootId` 遗留的 `started/processing` 补为 `interrupted`；
- `status` 表示业务结果，`level` 表示运行严重程度，二者不能混用；
- `degraded` 表示保留了可用结果但能力下降，是终态；`deferred` 不等同于 `error`，`denied` 不等同于系统崩溃；
- `significance` 由事件目录按 `eventName` 固定，调用方不可指定。

### 3.3 Actor / Executor / Target

`actor` 表示谁发起活动；`executor` 表示谁实际执行；`target` 表示主要影响对象。

```text
Actor kind:
user | agent | subagent | memory_agent | plugin | scheduler | system | supervisor

Executor kind:
service | agent | subagent | memory_agent | plugin | worker | system

Target kind:
platform | agent | session | turn | tool | file | workspace
memory_fact | memory_batch | plugin | provider | configuration | external_resource
```

示例：记忆调度器整理 Agent A 的 batch：

```text
actor.kind          = scheduler
executor.kind       = memory_agent
target.kind         = memory_batch
scope.ownerAgentId  = agent-a
```

### 3.4 Scope

```ts
interface EventScope {
  ownerAgentId?: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  taskId?: string;
  subagentRunId?: string;
  toolCallId?: string;
  pluginId?: string;
}
```

使用 `ownerAgentId` 表达活动归属，避免把临时 subagent、记忆 Agent 或插件误当作永久 Agent 身份。

### 3.5 Trace

```ts
interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationId?: string;
  correlationId?: string;
  linkedTraceIds?: string[];
}
```

- 一次用户 Turn 使用一个 `traceId`；
- 模型、工具、回想和当前 Turn 内 subagent 是子 span；
- 独立后台任务创建新 trace，并用 `linkedTraceIds` 指向来源；
- 使用 `AsyncLocalStorage` 自动传播，不要求每层手工传递全部 ID；
- Phase 11 的 trace 字段应保留未来映射 OpenTelemetry 的可能，但不依赖 OTel 包。

### 3.6 Producer

```text
component
processType = server | supervisor | web | plugin | worker
processId
bootId
appVersion
hostPlatform
```

`eventId`、`recordedAt`、`channel`、`actor`、`executor`、`scope`、`trace` 和 `producer` 是平台权威字段。插件或外部进程提交的事件必须由平台重新盖章。

### 3.7 三类 Payload

```text
DiagnosticPayload:
message + bounded attributes + sanitized error/stack

ActivityPayload:
summaryCode + durationMs + attempt + metrics + resultRef + relatedResources

AuditPayload:
action + decision + reasonCode + policyVersion
+ beforeRevision/afterRevision + changedFields + approver
```

`eventName` 和 `summaryCode` 使用稳定英文机器标识，中文文案由 Web 映射，不进入协议权威。

---

## 四、日志上下文与公共 API

平台模块统一接收：

```ts
interface ObservabilityContext {
  logger: DiagnosticLogger;
  activity: ActivityRecorder;
  audit: AuditRecorder;
  trace: TraceManager;
}
```

建议公共能力：

```text
logger.child(component, fixedContext)
logger.trace/debug/info/warn/error/fatal(eventName, message, attributes)

activity.start(eventName, context) -> ActivityOperation
ActivityOperation.processing(...)
ActivityOperation.complete(...)
ActivityOperation.fail(...)
ActivityOperation.cancel(...)
ActivityOperation.defer(...)

audit.append(action, decision, target, metadata)
trace.run(name, context, callback)
trace.link(sourceTraceId, targetTraceId)
```

要求：

- `ActivityOperation` 自动测量 duration，防止 start/terminal 字段漂移；
- 重复终态必须拒绝或幂等；
- recorder 内部负责 TypeBox 校验、脱敏、字段限额和持久化；
- 业务模块不直接构造完整 Envelope；
- `console.*` 仅允许 CLI 最终输出和 logger 自身的 emergency fallback；
- logger 不能用自己记录自己的持久化失败，避免递归风暴。

---

## 五、持久化与恢复

### 5.1 Diagnostic JSONL

路径：

```text
~/.opencolorful/logs/runtime/<processType>/YYYY-MM-DD_<bootId>_<segment>.jsonl
```

规则：

- 每进程独占文件；Server、Supervisor、插件进程不共享写句柄；
- 按级别分两类文件：trace/debug 写 `<date>_<bootId>_<segment>.debug.jsonl`（保留 7 天），info/warn/error/fatal 写主 `<date>_<bootId>_<segment>.jsonl`（保留 30 天）；分级保留以文件为单位执行，不要求行级清理；
- 单文件建议 10MB，达到上限滚动到下一 segment；
- 每行一个完整 JSON；
- 控制台可以 pretty，落盘始终 JSONL；
- 连续完全相同的诊断记录折叠为 repeat summary；
- 有界队列过载时按 trace → debug → info 顺序丢弃；
- warn/error/fatal 尽量保留；
- 写失败 fallback 到 stderr，不阻塞 Agent 对话；
- diagnostic 总磁盘预算默认 500MB：超限先删最旧 debug 文件、再删最旧主文件，并上报 health degraded。

### 5.2 `activity_events`

在现有 `metadata.sqlite` 中通过 **migration v8** 新增结构化活动表。Phase 10 使用 v6，Phase 10.5 已使用 v7；不得把 Phase 11 表追加到旧 migration。常用查询字段独立成列，完整安全 payload 保存为 JSON。`search_text` 复用 Phase 10 的 CJK 2/3-gram 实现，但应先将 memory 命名的 helper 抽为通用 search helper，避免 observability 反向依赖 memory 模块。

核心列：

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
event_id TEXT UNIQUE
schema_version / event_version
recorded_at / occurred_at
event_name / category / level / status / significance
actor_kind / actor_id
executor_kind / executor_id
target_kind / target_id
owner_agent_id / session_id / run_id / turn_id / task_id
subagent_run_id / tool_call_id / plugin_id
trace_id / span_id / parent_span_id / operation_id / correlation_id
duration_ms / error_code / retryable
producer_component / producer_process_type / boot_id
search_text / payload_json
```

实现时去掉上面示意中的排版空格，所有 NOT NULL、CHECK、外键和默认值必须在 migration 中显式定义。索引至少覆盖：

```text
recorded_at
owner_agent_id + recorded_at
session_id + recorded_at
trace_id
operation_id
event_name + recorded_at
status + recorded_at
level + recorded_at
significance + recorded_at
plugin_id + recorded_at
```

使用 FTS5 索引已经脱敏的 `eventName/component/errorCode/short summary`，不将 payload 全量送入 FTS。FTS rebuild、删除同步和损坏恢复必须有测试。

### 5.3 `audit_events`

独立 append-only Store 与表：

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
event_id TEXT UNIQUE
ledger_epoch INTEGER NOT NULL
recorded_at / occurred_at
action / decision / reason_code
actor_kind / actor_id
executor_kind / executor_id
target_kind / target_id
owner_agent_id / session_id
trace_id / operation_id
policy_version
before_revision / after_revision
changed_fields_json / payload_json
previous_hash / record_hash NULL
```

业务层只暴露：

```text
append / get / list / export / resetLedger
```

不暴露单条 update/delete。`previousHash/recordHash` 在 v1 中固定为 NULL，仅为未来 migration 预留；本阶段不运行 hash-chain 校验，也不宣称可对抗本机所有者篡改。普通写入路径只能 append，删除只能经过专用 `resetLedger` 事务。

### 5.4 Trace links、聚合与状态表

后台任务和跨进程工作不能只把 `linkedTraceIds` 塞进 payload JSON。migration v8 同时新增规范化关系表：

```text
observability_trace_links
source_trace_id TEXT NOT NULL
target_trace_id TEXT NOT NULL
relation TEXT NOT NULL
source_event_id TEXT
created_at TEXT NOT NULL
PRIMARY KEY (source_trace_id, target_trace_id, relation)
INDEX source_trace_id / target_trace_id
```

`activity_daily_metrics` 保存 retention 前的幂等日聚合；唯一键至少包含日期、owner Agent、metric kind 和维度 hash。`observability_state` 保存 migration/recovery、spool import cursor、retention watermark、audit ledger epoch 与 writer health。偏好设置不进入 migration：把现有 `PreferencesDocument.version` 从 1 升到 2，新增 `observability` 段，并通过已有 `PreferencesStore` 归一化、v1 → v2 迁移与原子写入。

### 5.5 可靠性等级

| 通道/场景 | 策略 |
|---|---|
| diagnostic | best effort；失败 fallback stderr；允许按优先级丢弃 |
| activity | durable-on-accept：recorder 只有在 SQLite 或 durable spool 成功后才返回 accepted；`eventId UNIQUE` 支持恢复重放 |
| activity 写入完全失败 | 不静默成功；返回结构化失败、累计 lost/failed count、health=critical；默认不反向撤销已经完成的普通业务 |
| 同库高风险 audit | 领域修改与 audit insert 必须同一 SQLite 事务；事务失败即拒绝操作，spool 不能授权脱离事务继续修改 |
| 文件/外部高风险 audit | 执行前必须先成功写入 SQLite 或 audit spool；两者都失败则拒绝操作 |

所有进入事件目录的 Activity 都是 durable semantic event，不允许先进入纯内存队列后再异步 flush。SQLite 可以在一次调用内部使用短 batch transaction，但 recorder 必须等 transaction/spool 落盘结果后再返回。纯内存 batch 只用于 diagnostic、重复计数和可由 Activity 重建的 metrics。

应急文件按写入进程隔离：

```text
logs/emergency/activity/<processType>-<bootId>-<segment>.jsonl
logs/emergency/audit/<processType>-<bootId>-<segment>.jsonl
```

正常情况下由 Server 统一写 activity/audit；Server 不可用时，Supervisor 只能写自己的 spool，插件和 worker 不能直接打开平台 spool。单 segment 默认 10MB；activity spool 总预算默认 128MB，超限后拒绝新 Activity 记录并暴露 critical health，不得伪装为成功。audit spool 不允许静默丢弃；达到配置上限后，所有需要 durable audit 的高风险操作 fail closed。

启动恢复：

1. 枚举各进程 spool segment，按文件内顺序逐行校验并再次脱敏；
2. 坏行写入同目录 quarantine 文件，原 segment 保留，不因单行损坏丢弃全文件；
3. 按 `eventId UNIQUE` 幂等导入 SQLite；
4. 全部成功后原子归档/删除对应 segment；
5. 导入失败暴露 degraded/critical health，不阻塞普通 Session 恢复；
6. spool-only 事件在导入 SQLite 前不得进入实时流。

### 5.6 Audit 事务、文件操作与 ledger reset

- 同一 SQLite 内的领域修改与 audit insert 必须使用同一个显式 transaction helper；
- 文件类修改使用 `audit started durable → atomic temp/fsync/rename → audit terminal`，保存 before/after revision；
- 启动恢复检查旧 `bootId` 未终结的高风险 operation，读取目标 revision 后补写 completed/failed/interrupted；
- 外部 API 无法本地事务化，只记录真实 started/terminal 与远端结果摘要；
- fail-closed 清单冻结为：删除、工作区/权限/沙箱策略变更、记忆审批/遗忘/强度变化、插件授权、凭据变更和 audit ledger reset；
- Audit 清理只能调用 `resetLedger`：在单事务内递增 `ledger_epoch`、清理旧 epoch，并在新 epoch 插入 `audit.ledger.reset`，记录操作者、原因、旧 epoch、删除数量和时间范围；
- ledger reset 前必须展示影响范围并要求显式确认；普通 Store API 永远不暴露行级删除。

### 5.7 持久化后实时投影

Observability 不复用 Session/Agent 的 `PlatformEventEnvelope`、`EventSequenceGuard` 或内存 `EventReplayStore`。日志工作页使用独立、按通道拆分的 SSE cursor 协议：

```text
GET /api/observability/activity/stream   Last-Event-ID: <activity id>
GET /api/observability/audit/stream      Last-Event-ID: <audit id>
```

规则：

- SQLite commit 成功后才允许向对应 SSE 连接发送记录；
- SSE `id` 直接使用对应表自增 `id`，它是单调 cursor，允许因回滚、幂等冲突或 retention 出现空洞，不承担“从 1 连续”的 Session sequence 语义；
- 重连时先查询 `id > cursor ORDER BY id`，再切换到 live follow，交接过程必须通过高水位避免丢失和重复；
- spool-only 事件不广播，导入 SQLite 后才获得 cursor；
- cursor 早于当前最小可用 id，或 audit epoch 已变化时，服务端发送 `reset` 控制事件，包含 `minAvailableId/currentLedgerEpoch/reason`，客户端清空局部投影并重新查询；
- `/api/observability/health` 直接读取 writer、队列、spool 和磁盘状态；数据库故障时不能依赖写入 `observability.health.changed` 来报告自身故障；
- Agent 对话 SSE 与 operator observability SSE 完全分离，不向 `EVENT_TYPES` / Web `KNOWN_EVENT_TYPES` 添加 Activity 的每个 `eventName`。

---

## 六、第一批事件目录

### 6.1 注册表是唯一权威

Phase 11 必须新增代码内置的 `ObservabilityEventCatalog`，每个 durable event 都有且只有一条注册记录：

```ts
interface EventCatalogEntry<TSchema> {
  eventName: string;
  eventVersion: number;
  channel: "activity" | "audit";
  category: string;
  defaultLevel: "info" | "warn" | "error";
  significance?: "routine" | "notable" | "milestone";
  lifecycleRole: "started" | "progress" | "terminal" | "point";
  payloadSchema: TSchema;
  auditMirror?: string;
  securitySummary: SecuritySummaryPolicy;
  producerPolicy: "platform-only" | "extension-allowed";
}
```

调用方只能提交目录允许的领域字段，不能覆盖 `channel/defaultLevel/significance`。Recorder 先按 `eventName + eventVersion` 查目录，再校验 payload、生成 Envelope、脱敏并持久化；未注册事件默认拒绝。新增或升级事件必须同时修改目录、TypeBox schema、Web 文案映射和契约测试。

Diagnostic 不进入该 durable registry，但必须使用受控的 component 与稳定 event name。Transport-only 事件继续由 `PlatformEventEnvelope` 维护，两者不能混放。

### 6.2 Durable Activity

第一批 Activity 至少覆盖：

```text
平台与存储
system.starting / started / stopping / stopped / crashed
system.recovery.started / completed / failed
supervisor.server.started / stopped / restarted / crashed
supervisor.health.degraded / recovered
storage.database.opened / failed
storage.migration.started / completed / failed
storage.repair.started / completed / failed
storage.corruption.detected
storage.write.failed

Agent 与 Session
agent.created / started / stopped / archived / deleted
agent.base_color.changed
agent.settings.changed
agent.workspace.changed
agent.migration.completed / failed
session.created / bound / opened / archived / unarchived
session.workspace.bound
session.compaction.started / completed / failed
session.recovery.completed / failed

Turn、模型与 Provider
turn.started / completed / failed / cancelled / interrupted
model.call.started / completed / failed / cancelled
model.call.retrying / rate_limited
model.fallback.selected
provider.configured / tested / degraded / recovered
provider.credential.changed

工具与沙箱
tool.call.started / completed / failed / cancelled / denied
tool.approval.requested / granted / denied
workspace.operation.failed
sandbox.path.denied
sandbox.command.denied
sandbox.policy.changed
sandbox.context.missing
sandbox.guard.failed

记忆
memory.summary.started / completed / degraded / failed
memory.compile.started / completed / failed
memory.recall.started / completed / empty / failed / cancelled
memory.batch.sealed / processing / deferred / completed / failed
memory.agent.started / completed / deferred / failed / interrupted
memory.proposal.created / approved / rejected / conflicted
memory.strength.changed
memory.fact.superseded / forgotten / suppressed
memory.scheduler.run.started / completed / failed / deferred / recovered

接口与连接
api.request.failed
api.validation.failed
sse.connected / disconnected / replay.reset
ws.connected / disconnected / reconnected / protocol.failed
client.unhandled_error
client.render.failed
```

正常 health success、普通 SQLite query、每个 HTTP 200、每个 token/chunk 和普通 React render 不进入 Activity。模型和工具只记录安全摘要、耗时、attempt、Token 与有限结果类型，不记录完整 Prompt、回复、args/result 或 Provider 原始 body。

### 6.3 Durable Audit 与镜像规则

以下行为必须有 Audit；其中同名 Activity 用于时间线，Audit 用于责任与策略证据：

```text
agent.deleted
agent.workspace.changed
session.workspace.bound
sandbox.path.denied / command.denied
sandbox.policy.changed
tool.approval.granted / denied
provider.credential.changed
memory.proposal.approved / rejected
memory.strength.changed
memory.fact.forgotten / suppressed
plugin.permission.granted / denied / revoked
observability.preferences.changed
observability.retention.executed
observability.export.created
observability.audit.ledger_reset
```

Audit 只保存 actor、executor、target ID、revision、changed fields、policy version 与 reasonCode。记忆审批、遗忘、suppression、永久晋升和强度变化不得保存完整记忆正文；工作区和工具审计不得保存原始敏感路径、命令或参数。

### 6.4 Transport-only 与 Diagnostic-only

以下高频或中间态保留在现有 UI transport，不落 Activity/Audit：

```text
message.delta
thinking.delta
tool.delta
memory.recall.layer_changed
memory.agent.layer_changed
memory.agent.processing 的高频进度
每个 SSE chunk / token delta / stdout chunk
```

需要排错时，可由对应模块写受限 Diagnostic，但不能把完整正文复制到 Diagnostic。`memory.recall.completed/empty/failed/cancelled` 是 durable Activity；`memory.recall.layer_changed` 只是“正在回想”的界面状态。

### 6.5 Significance 冻结策略

- `milestone`：永久 Agent 生命周期边界，例如 `agent.created/agent.deleted`；只允许平台内置目录注册；
- `notable`：Agent 关键设置、工作区、Session 归档、Provider 状态、记忆审批/强度和系统 migration/recovery 结果；
- `routine`：Turn、模型、工具、回想、摘要、batch、连接和普通失败恢复；
- 插件自定义事件一律从 `routine` 开始，且不能携带 `auditMirror`；提升为 `notable/milestone` 或产生平台 Audit 必须经过平台 manifest 权限审核和用户授权；
- significance 变化属于事件语义变更，必须提升 `eventVersion` 并提供 retention 迁移说明。

---

## 七、未来功能接入契约

### 7.1 强制规则

后续每个 Phase 都必须在设计中增加“可观测性契约”：

1. 活动事件目录；
2. 安全审计行为；
3. 继承的 Agent/Session/trace 上下文；
4. 敏感字段和安全摘要规则；
5. 失败、取消、超时、重启语义；
6. UI 投影和可查询字段；
7. 可派生指标；
8. schema、脱敏、trace、recovery 测试。

### 7.2 插件

平台自动记录：

```text
plugin.installed / updated / enabled / disabled / uninstalled
plugin.process.started / exited
plugin.execution.started / completed / failed / cancelled
plugin.permission.requested / granted / denied / revoked
plugin.integrity.failed
plugin.sandbox.denied
```

插件自定义事件使用注册命名空间：

```text
plugin.<pluginId>.<domain>.<action>
```

插件 manifest 声明事件名称、版本和 payload schema，但自定义事件默认只能注册为 `routine` Activity，不能自行产生 Audit、`notable` 或 `milestone`。平台注入 eventId、recordedAt、actor、executor、scope、trace、producer；插件不能直接写 Store、spool 或伪造权限结果。stdout/stderr 由平台捕获、脱敏、限长、折叠和限速。AsyncLocalStorage 不跨进程：平台向插件/worker 发放只读、短期的 trace carrier，IPC 返回时校验 carrier 与调用实例，再由平台重新盖章；插件提交的任意 trace/ownerAgent/producer 字段一律忽略。

### 7.3 Subagent

平台自动记录：

```text
subagent.delegated / started / processing
subagent.completed / failed / cancelled / interrupted
```

当前 Turn 内 subagent 继承父 trace 并建立子 span；独立后台 subagent 建立新 trace，并在 `observability_trace_links` 写入 `delegated_to` 关系，`linkedTraceIds` 只作为 Envelope 展示字段。活动使用 `ownerAgentId` 归入永久 Agent，不把临时 subagent 当作持久 Agent 身份。查询 linked graph 时限制最大深度、节点数并检测环。

### 7.4 其他未来功能

| 功能 | 必须接入的事件 |
|---|---|
| 技能 | 安装、更新、启用、执行、失败、权限、版本 |
| 自动任务 | 创建、触发、延期、跳过、完成、超时、取消 |
| 多 Agent 社交 | 邀请、连接、委派、投递、拒绝、协作结果 |
| Bridge/外部渠道 | 接收、路由、投递、重试、失败；不记录消息正文 |
| 浏览器 | 导航、交互、下载、权限和失败；URL query 脱敏 |
| 成长系统 | 提案、验证、接受、拒绝、回滚 |

---

## 八、脱敏与数据限制

### 8.1 永不记录

```text
API Key / Authorization / Cookie / Set-Cookie
access token / refresh token / password / private key
完整 Prompt / 回复 / 隐藏 reasoning
完整记忆正文
完整文件内容
完整工具 args/result
Provider 原始响应体
data URL / base64 大对象
```

### 8.2 两阶段脱敏

1. 写入前：字段 allowlist + secret-key masking + 文本模式扫描 + 路径归一化；
2. 导出前：对已经落盘的数据再次执行更严格脱敏。

至少覆盖：

- Authorization/Bearer/Cookie；
- 常见 Provider Key 格式；
- secret/token/password 类对象键；
- URL credential 和敏感 query；
- email、身份证、SSN、信用卡等明显 PII；
- 用户主目录显示为 `~`，额外敏感路径显示为 `[path]`；
- Windows/Unix 路径变体；
- Error message、stack、nested object、数组和循环引用。

### 8.3 建议限额

```text
eventName             120 chars
diagnostic message    4KB
stack                 16KB
单 attribute string   2KB
attributes count      32
对象深度              5
数组长度              50
持久化 payload JSON   32KB
插件每分钟自定义事件   可配置硬上限
```

超限字段截断并附带 `truncated=true`，不能让一条日志无限膨胀。

---

## 九、保留、聚合与清理

默认策略：

| 数据 | 保留 |
|---|---|
| diagnostic trace/debug | 7 天 |
| diagnostic info/warn/error/fatal | 30 天 |
| activity routine | 180 天 |
| activity notable | 2 年 |
| activity milestone | 长期 |
| audit | 长期 |
| daily metrics | 长期 |
| emergency spool | 成功导入后删除 |

diagnostic 磁盘预算：总量默认 500MB，超限先删最旧 debug 文件、再删最旧主文件，并暴露 health degraded。

隐私删除不级联：Agent 或记忆被隐私删除时，activity/audit 不级联清理——日志只保存 ID、revision 与 reasonCode，不含正文，事实源删除后日志不构成内容副本。

清理 routine 活动前先写入 `activity_daily_metrics`：

```text
Agent/日期/Provider/模型调用次数与错误率
Token 总量、平均延迟、TTFT
工具调用次数、失败率、取消率
沙箱拒绝次数
记忆回想命中率、empty 率、下钻层级、延迟
记忆 batch 积压、成功率、延期次数
后台任务等待和完成时间
```

Routine 清理必须在同一事务内执行“按日聚合 UPSERT → 写 retention watermark → 删除已聚合 Activity”，唯一键保证重复执行不会重复累计。日志清理、保留策略修改、诊断导出和 audit ledger reset 本身进入 Audit。用户可显式清理本地数据，但必须先通过 preview 看见预计释放空间、最早/最晚时间和影响范围；Audit 只能按第 5.6 节执行 ledger reset，不能按日期静默删除单行。

---

## 十、查询、健康与实时接口

建议 API：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/observability/activity` | 活动查询、cursor 分页和过滤 |
| GET | `/api/observability/activity/:eventId` | 单条活动详情 |
| GET | `/api/observability/activity/stream` | Activity 独立 SSE，cursor=表 id |
| GET | `/api/observability/audit` | 安全审计查询 |
| GET | `/api/observability/audit/stream` | Audit 独立 SSE，cursor=表 id 与 ledger epoch |
| POST | `/api/observability/audit/reset` | 显式确认后的 ledger reset |
| GET | `/api/observability/traces/:traceId` | trace/span tree，可选包含 linked graph |
| GET | `/api/observability/diagnostic/tail` | 指定进程/文件的脱敏 tail |
| POST | `/api/observability/client-events` | Web 客户端错误上报 |
| GET | `/api/observability/metrics` | 派生指标和趋势 |
| GET | `/api/observability/health` | writer、spool、磁盘、失败计数与 ledger epoch |
| GET/PUT | `/api/preferences/observability` | 级别、保留期和大小上限 |
| POST | `/api/observability/export` | 生成脱敏诊断包 |
| POST | `/api/observability/retention/preview` | 估算影响范围与释放空间 |
| POST | `/api/observability/retention/run` | 手动执行幂等清理/聚合 |

Activity 过滤条件至少包括：

```text
from/to
ownerAgentId/sessionId
eventName/category
level/status/significance
component/errorCode
traceId/operationId
pluginId
query
beforeId/afterId/limit
```

分页顺序固定为 `recorded_at DESC, id DESC`，cursor 必须包含最后一条记录的 `recordedAt + id`，避免相同时间戳重复或漏项。linked trace 查询返回 bounded graph，响应明确 `truncated/maxDepth/maxNodes`。

实时接口遵循第 5.7 节的独立 SSE cursor 契约，只发送已经 commit 的完整脱敏记录和 `reset` 控制事件；不使用 `observability.activity.appended` 之类的 `PlatformEventEnvelope` 类型。Health 默认轮询，也可以在 Activity Store 正常时投影为普通 durable Activity，但 UI 不能依赖该投影发现 Store 自身故障。

`POST /api/observability/client-events` 只接受 `client.unhandled_error` 和 `client.render.failed` 两种内置 schema，body 上限 64KB、payload 持久化上限 32KB；校验 JSON Content-Type、配置的本机 UI Origin 和每客户端/全局速率。服务端忽略客户端提交的 eventId、actor、scope、trace、producer、level 与 significance，不接收用户输入、URL query、DOM snapshot 或 React props 原文。

### 诊断包

导出内容建议包括：

- manifest：版本、生成时间、平台、Node、schema 版本；
- 配置 shape，不含配置值和凭据；
- 最近脱敏 diagnostic tail；
- 失败/降级 activity；
- observability/memory/sandbox/scheduler health；
- migration 和数据库完整性摘要；
- 用户选择的 trace；
- privacy manifest：列出 `redactionVersion`、`includedSections`、`rawPayloadIncluded=false`、`factSourcesIncluded=false`、`rawLogsIncluded=false`；导出的 Activity/Audit 仅含二次脱敏后的 allowlist 字段。

写入私有目录或 ZIP；路径必须防穿越，文件权限尽量限制为当前用户。

---

## 十一、Web 日志与诊断工作页

建议新增独立 `/logs` 工作页，现有 Settings “日志与诊断”入口跳转或嵌入摘要，不再把完整体验限制在小型 settings section。

页面视图：

```text
活动 | 错误 | 安全审计 | 性能 | 原始日志 | 诊断导出
```

### 活动

- Agent、Session、时间、类别、状态、组件过滤；
- 按时间线显示 started/terminal；
- 展开查看 actor/executor/target/scope；
- 进入完整 trace 树；
- 跳转对应 Agent、Session、Turn 或记忆对象。

### 错误

- failed/degraded/interrupted/denied 聚合；
- 相同错误折叠，展示首次/最近时间与次数；
- 展示 errorCode、retryable、attempt 和恢复结果；
- 不向 UI 暴露未脱敏 stack/payload。

### 安全审计

- action、decision、actor、target、policy version；
- before/after revision 与 changed fields；
- 审计导出和显式清理入口；
- 默认只读，不提供修改单条记录。

### 性能

- 模型延迟、TTFT、Token、错误率；
- 工具耗时和失败率；
- 记忆 recall/batch/整理指标；
- 日/周趋势，不做营销式 dashboard。

### 原始日志

- 进程、bootId、level、component、query 过滤；
- follow tail、暂停、清空视图、下载脱敏文件；
- 稳定尺寸的等宽日志查看器；
- 不在浏览器中加载整个日志文件。

### 状态

必须提供 loading、empty、error、degraded、spool pending、disk limit、events dropped 和 reset 状态。

---

## 十二、实施任务

### T1：契约、事件目录与 migration v8

- 新增 Observability 判别联合 Envelope、Actor/Executor/Resource/Scope/Trace/Producer、三类 payload 和 SafeValue 类型；
- 新增 `ObservabilityEventCatalog`，完整登记第六章事件的 channel、level、significance、lifecycle、schema、security summary 和 audit mirror；
- migration v8 新增 `activity_events`、FTS、`audit_events`、`observability_trace_links`、`activity_daily_metrics` 和 `observability_state`；
- 从 v7 升级和全新数据库两条路径必须生成相同 schema；
- 将 CJK 2/3-gram helper 抽成 storage/search 公共能力；
- 将 `PreferencesDocument` 升级到 v2，在现有 `preferences.json` 增加 `observability` 段并实现 v1 → v2 归一化迁移，不在 SQLite 建 preferences 表。

完成条件：契约正反例、目录完整性、migration 快照和 preferences 旧版本归一化测试通过。

### T2：上下文、脱敏与 Diagnostic Logger

- 实现 AsyncLocalStorage trace context、child logger、bootId、component 与显式 IPC trace carrier；
- 实现 SafeValue normalize、字段 allowlist、secret/PII/path redaction、Error cause/stack 清洗和限额；
- 实现 debug/main 双 JSONL、10MB rotation、repeat folding、backpressure、7/30 天文件保留和 500MB 总预算；
- 迁移可直接替换的 `console.*` 与 `server.log`，保留 CLI 最终输出和 logger emergency stderr。

完成条件：并发 Session 不串 trace；Windows 多进程不共享 writer；脱敏攻击夹具通过。

### T3：Activity/Audit Store、事务与应急恢复

- 实现 Event Catalog 驱动的 ActivityRecorder、AuditRecorder 和 ActivityOperation；
- 实现 durable-on-accept、唯一终态、eventId 幂等和旧 boot interrupted reconcile；
- 实现同库领域修改 + Audit 的 transaction helper；
- 实现每进程分段 spool、预算、quarantine、幂等导入与 health 状态机；
- 实现 audit `ledger_epoch` 与专用 `resetLedger`，hash 字段保持 NULL。

完成条件：SQLite/spool 故障矩阵、同库回滚、文件操作 reconcile、spool-only 不广播和 ledger reset 测试通过。

### T4：平台核心埋点

- 接入 system、Supervisor、storage、Agent、Session、Turn、model、Provider、API、SSE 与 WS；
- 平台边界自动产生 started/terminal，领域模块只提交补充语义；
- 逐项替换零散日志，不能重复记录同一 Activity；
- 验证启动、停止、崩溃、恢复和 migration 失败链路。

完成条件：一次 Turn 可按 trace 还原主 Agent、模型、工具前后的核心链路。

### T5：工具、沙箱与记忆链路

- 接入 tool lifecycle 与每工具独立 security summary；
- 将 Phase 9 sandbox denial 迁移为 Activity + Audit，旧 security JSONL 只做兼容导入或停止写入，不能双写为两个事实源；
- 接入 Phase 10/10.5 summary、compile、recall、batch、proposal、strength、scheduler、recovery；
- 保持 `memory.recall.layer_changed`、`memory.agent.layer_changed` 为 transport-only。

完成条件：工具参数、文件内容和记忆正文不入日志；记忆审批与强度修改拥有同 trace 的 Activity/Audit 证据。

### T6：查询、独立实时流与客户端错误入口

- 实现 Activity/Audit cursor 查询、FTS、错误分组、trace tree 和 linked graph；
- 实现按通道拆分的 operator SSE，DB cursor 允许空洞，支持 retention/epoch reset；
- 实现 health、metrics、diagnostic tail 与受限 client-events；
- 查询/实时交接使用数据库高水位，确保重连不重不漏；
- client-events 落实 Origin、Content-Type、body size、schema 和双层速率限制。

完成条件：数据库重连、cursor gap、spool import、retention reset、linked reverse lookup 和恶意客户端输入测试通过。

### T7：Web `/logs` 工作页

- 完成活动、错误、安全审计、性能、原始日志和诊断导出六个视图；
- 实现稳定过滤栏、虚拟化时间线/表格、详情面板、trace tree/linked graph 和 live follow；
- 实现 loading、empty、error、degraded、spool pending、disk limit、events failed 与 reset 状态；
- Settings 只保留 observability 设置、health 摘要和跳转入口；
- 未知 future/plugin event 使用目录元数据或通用展示，不崩溃。

完成条件：桌面与移动 viewport 无重叠；大日志不全量载入；Playwright 覆盖查询、follow、reset、导出与设置。

### T8：未来扩展 Observability Port

- 冻结 `ExtensionObservabilityPort`，只暴露受限 diagnostic/activity/trace carrier，不暴露 Store、spool 和 AuditRecorder；
- 插件 namespace/schema/rate/significance 权限由平台 manifest 校验；
- subagent 同步继承 trace，后台任务写规范化 trace link；
- fake plugin/subagent harness 验证身份重新盖章、越权字段忽略、routine 默认和崩溃终态。

完成条件：扩展不能伪造 actor/owner/trace/producer、不能直接制造长期事件或 Audit。

### T9：Retention、聚合、导出与运维

- 实现幂等 daily metrics、retention watermark、preview/run 和 diagnostic/spool 磁盘预算；
- 实现 audit ledger reset 预览、显式确认和 UI 投影；
- 实现 support bundle、二次脱敏、privacy manifest、私有输出目录与 ZIP 防穿越；
- 导出失败不修改或删除任何源日志。

完成条件：重复 retention 结果一致；删除前已聚合；诊断包不包含事实源正文和凭据。

### T10：质量门与真实验收

- 独立运行 PI SDK 边界、strict typecheck、server/web tests、生产构建和 Playwright；
- 使用隔离 `OPENCOLORFUL_HOME` 完成 browser-use 验收；
- 制造 SQLite busy/failure、spool 损坏、进程崩溃、旧 cursor、audit reset 和磁盘超限场景；
- 回写实施记录、已知偏差、测试数量和截图证据。

依赖关系：

```text
T1 ─┬─→ T2 ─→ T3 ─┬─→ T4 ─→ T5
    │              ├─→ T6 ─→ T7
    │              └─→ T8
    └───────────────→ T9（Store 完成后集成）
T4/T5/T6/T7/T8/T9 全部完成 → T10
```

---

## 十三、测试要求

### 契约、目录与脱敏

- 三种判别 Envelope/payload TypeBox 正反例，channel 与 payload 不可错配；
- 目录无重复/遗漏，调用方不能覆盖 level/significance/channel；未知 event/version 拒绝；
- 插件自定义事件默认 routine，不能注册 milestone/Audit；
- actor/executor/scope/trace/producer 平台字段不可被 Web/插件覆盖；
- secret-like keys、Bearer、Cookie、URL credential、Provider key、base64、PII、Windows/Unix 路径；
- Error cause/stack、循环引用、深对象、长数组和超长字符串；
- 写入与导出双重脱敏，不记录完整 Prompt、memory content、tool args/result。

### 生命周期与 trace

- started 对应唯一终态，重复 terminal 幂等；
- Turn → model → tool → recall 子 span 关系；
- 当前 Turn subagent 继承 trace；后台 subagent 建立 indexed trace link；
- linked graph 支持正反向查询、环检测、深度/节点截断；
- 旧 boot running 自动 interrupted；并发 Session 上下文不串线；
- IPC carrier 不能被插件替换为任意 trace/owner。

### Migration、存储与恢复

- 空数据库直接迁移到 v8；真实 v7 fixture 升级到 v8 且保留 Phase 10.5 数据；
- activity/audit eventId 幂等，FTS trigger/rebuild 与主表一致；
- 同库事务失败同时回滚领域状态和 Audit，spool 不得授权继续写领域表；
- Activity 只有 SQLite/spool 成功才返回 accepted，不存在纯内存 flush 丢失窗口；
- 每进程 spool 写入、分段、预算、坏行 quarantine、重启导入、重复导入和部分失败；
- spool-only 事件不广播，导入后才进入实时流；
- Audit spool 满或两种介质都失败时高风险操作拒绝；
- ledger reset 原子递增 epoch、删除旧 ledger 并留下新 reset 记录；
- Preferences v1/缺失/损坏输入都归一化为包含 observability 默认值的新版本。

### 查询、实时与 Web

- Agent/Session/trace/event/status/significance/time/query 过滤；
- 复合 cursor 在相同 recordedAt 下不重不漏；FTS 不索引敏感 payload；
- SSE cursor 允许 id 空洞；查询/live 高水位交接不丢失；旧 retention cursor 与旧 audit epoch 触发 reset；
- Health 在 SQLite 不可用时仍能通过直接端点显示 spool 和 writer 状态；
- client-events 拒绝错误 Origin、超限 body、未知 event 和伪造权威字段；
- 活动、错误、审计、性能、原始日志和导出页面状态；
- 大日志文件不全量加载；未知 future/plugin event 使用通用展示。

### Retention 与诊断包

- daily metrics UPSERT + watermark + delete 幂等，重复执行不重复计数；
- preview 与 run 的范围一致，routine/notable/milestone 分级正确；
- ZIP/目录路径不穿越，文件权限与重复路径保护；
- privacy manifest 正确，不包含 auth、Session JSONL、memory.md、原始 Provider body；
- 导出失败不删除源日志。

---

## 十四、验收标准

- [ ] diagnostic/activity/audit 三通道职责明确；Observability Envelope 与 Platform transport Envelope 保持分离；
- [ ] migration v8 可从真实 v7 数据库升级，也可从空数据库完整创建；
- [ ] 事件目录固定 channel/level/significance/schema，未注册和越权事件被拒绝；
- [ ] 所有关键长任务都有 started 与唯一终态；重启后旧 running 能补为 interrupted；
- [ ] Agent/Session/Turn/model/tool/sandbox/memory 当前关键链路均能按 trace 查询；
- [ ] linked trace 可正反向查询，ownerAgentId 能正确归属主 Agent、记忆 Agent、未来 subagent 和 plugin；
- [ ] diagnostic 每进程独立双 JSONL、10MB 轮转、7/30 天保留和 500MB 总预算均生效；
- [ ] Activity durable-on-accept，不存在未落盘的权威内存 batch；写入失败在 health/UI 明确可见；
- [ ] emergency spool 按进程隔离、可恢复且幂等；坏行不破坏整个 segment；
- [ ] 同库高风险修改与 Audit 同事务；文件/外部高风险修改在 Audit 完全不可持久化时 fail closed；
- [ ] SQLite commit 后才广播；spool-only 不广播；独立 SSE cursor 重连、gap 和 reset 不重不漏；
- [ ] Audit 普通路径 append-only，专用 ledger reset 原子、可确认且留下新 epoch 记录；
- [ ] Web 客户端错误入口落实 schema、Origin、大小和速率限制，平台重新盖章；
- [ ] 隐私删除不级联清理 Activity/Audit，且日志不含被删对象正文；
- [ ] 日志不包含 API Key、Authorization、Cookie、完整 Prompt、完整记忆、文件内容或完整工具输入输出；
- [ ] `/logs` 页面具备活动、错误、审计、性能、原始日志和诊断导出完整状态；
- [ ] 诊断包经过二次脱敏，包含 privacy manifest，不包含原始敏感事实源；
- [ ] retention 按 significance 分级，routine 清理前形成幂等 daily metrics；
- [ ] fake plugin/subagent 通过统一 Observability Port 接入，不能覆盖权威字段或制造长期事件；
- [ ] 日志永不自动进入 Agent 上下文或长期记忆；
- [ ] 全部质量门、Playwright 与 browser-use 验收通过。

---

## 十五、风险与缓解

| 风险 | 缓解 |
|---|---|
| 为追求“完整”记录原始敏感内容 | 语义完整而非 payload 完整；字段 allowlist；写入和导出双重脱敏 |
| Activity 同步持久化影响对话延迟 | 只记录 semantic lifecycle；短事务；实测 P95/P99；不记录 token delta 和高频进度 |
| Activity 完全不可写却被误认为成功 | durable-on-accept；显式 recorder result；health critical 和失败计数 |
| 日志自身故障递归刷屏 | emergency sink 不调用 logger；汇总 dropped/failed count；health 直接读取状态 |
| SQLite 体积持续增长 | 分级保留；幂等 daily metrics；磁盘预算；preview 后显式清理 |
| 多进程 Windows 轮转/应急文件冲突 | diagnostic 与 spool 均按 processType/bootId 独立；Server 恢复后统一导入 |
| spool 长期积压填满磁盘 | 分段与总预算；Activity 拒绝并 critical；Audit 满时高风险 fail closed |
| 插件伪造身份或制造永久日志 | 平台重新盖章；routine 默认；manifest 权限；受限 Port；插件不可接触 Store/spool/Audit |
| subagent 因果链无法回查或形成环 | 规范化 trace link；双向索引；bounded graph 与环检测 |
| 日志成为记忆反馈回路 | 日志不注入、不自动提取；未来引用必须显式 sourceType 与审批 |
| started 无终态 | ActivityOperation；唯一终态约束；boot recovery interrupted |
| 实时流与数据库状态不一致 | commit 后广播；DB cursor；高水位交接；spool 导入前不广播 |
| Audit 与文件修改无法原子 | durable started；atomic rename；revision；启动 reconcile |
| audit reset 破坏 append-only 语义 | 专用事务与 ledger epoch；普通 API 无 delete；新 ledger 保留 reset 记录 |
| 诊断包再次泄密 | 二次脱敏、privacy manifest、内容 allowlist、攻击夹具测试 |

---

## 十六、最终评审决议（2026-08-01）

1. **Envelope 分离**：Observability Envelope 不与 `PlatformEventEnvelope` 合并，只共享 Actor/Scope/Trace 等值类型。
2. **复用 `metadata.sqlite`**：Phase 11 使用 migration v8；只有容量、VACUUM 或查询 P99 的实测数据证明有压力后才考虑拆库。
3. **可靠性表述**：Activity 为 durable-on-accept，不使用未落盘的权威内存 batch；Audit 高风险操作为 durable-or-reject。
4. **fail-closed 清单**：删除、工作区/权限/沙箱策略、记忆审批/遗忘/强度、插件授权、凭据和 audit ledger reset。
5. **事件目录权威**：channel、level、significance、payload schema 和 audit mirror 均按 eventName/version 固定，调用方不可指定。
6. **spool**：按 processType/bootId 分文件；坏行 quarantine；eventId 幂等导入；spool-only 不进入实时流。
7. **实时流**：operator Activity/Audit 使用独立 SSE 与 SQLite cursor；cursor 允许空洞，不复用 Session 的连续 sequence/Replay Store。
8. **ALS 与 IPC**：ALS 不跨进程；插件/worker 使用平台签发或绑定调用实例的 trace carrier，入口重新盖章。
9. **记忆事件归属**：recall/batch/proposal/strength/scheduler 生命周期是 durable Activity；审批/遗忘/强度另进 Audit；layer_changed 是 transport-only。
10. **Trace link**：跨后台任务关系写入规范化 `observability_trace_links`，不能只保存在 JSON。
11. **Audit reset**：v1 普通路径 append-only；显式 reset 通过 ledger epoch 事务完成并留下新 ledger 记录。
12. **插件事件权限**：插件自定义事件默认 routine，不能自行注册 notable/milestone 或 Audit。
13. **Web 边界**：完整体验位于 `/logs`；Settings 只保留设置、健康摘要与入口；client-events 是受限本机端点。
14. **Diagnostic 预算**：10MB/文件、debug 7 天、main 30 天、总量 500MB；多进程不共享文件句柄。
15. **Hash chain**：v1 只预留 NULL 字段，不实现或宣传防篡改校验链。

---

## 实施记录

分支：`phase-11-logging`（基于 `phase-10.5-memory-agent`，Phase 10.5 不合并）

| Task | 提交 | 内容摘要 |
|---|---|---|
| T1 | 37bd8d4 | 契约（三通道 Envelope/payload/SafeValue）、事件目录（~150 事件 + auditMirror）、migration v8（activity/audit/trace_links/daily_metrics/state）、preferences v2 + observability 段、CJK n-gram 抽取 |
| T2 | f0aba8c | ALS trace 上下文、SafeValue 脱敏（secret/Bearer/Cookie/URL 凭据/PII/路径）、双 JSONL DiagnosticLogger（10MB 轮转/折叠/500MB 预算/7-30 天保留） |
| T3 | 7b32296 | ActivityRecorder（durable-on-accept/eventId 幂等/唯一终态/reconcile）、AuditRecorder（同库事务 fail-closed/ledger reset）、EmergencySpool（分段/预算/quarantine/幂等导入）、ObservabilityContext（startupRecovery/health） |
| T4 | d06ab69+26c2338 | Instrument 门面接线：system/storage/session/turn/model/tool/api/SSE/WS 埋点、turn trace 贯穿、API 计时中间件、supervisor 进程 context |
| T5 | efe0126 | sandbox denial JSONL → Activity+Audit（路径/命令不落盘）、记忆链路（summary/compile/recall/batch/scheduler/proposal/strength/fact 事件 + 后台 trace + audit 证据） |
| T6 | 7abcd03 | ObservabilityQuery（cursor 分页/FTS/错误分组/trace tree/linked graph/日指标）、operator SSE（表 id cursor + 高水位交接 + gap/reset）、受限 client-events（Origin/Content-Type/大小/schema/双层限速） |
| T7 | 882d338 | Web /logs 六视图工作页（活动/错误/审计/性能/原始日志/导出）+ live follow + 八类状态 + Settings 入口 |
| T8 | 50cc94f | 冻结 ExtensionObservabilityPort（routine 固定/平台盖章/速率限制/只读 trace carrier）、后台任务规范化 trace link、plugin.crashed |
| T9 | b72f43e | 幂等 retention（聚合→watermark→删除同事务）、preview/run、audit reset 显式确认、support bundle（二次脱敏 + privacy manifest + 防穿越）、preferences 端点 |
| T10 | （本提交） | 全量质量门 + browser-use 真实验收 + 回写 |

### 质量门结果（T10 最终轮）

- `npx tsc --noEmit -p tsconfig.json` / `npx tsc -p tsconfig.build.json`：0
- `npx vitest run`：76 files / 742 tests 全绿（含 T1-T9 全部新增测试）
- `node scripts/verify-pi-sdk-imports.mjs`：0（仅 src/pi-sdk 可导入 @earendil-works/pi-*）
- web：tsc 0、vitest 348 全绿、生产构建 0
- Playwright e2e：52/52（含 7 个 /logs 用例）；已知端口抢占 flake（workspace server-start 用例并行时偶发，隔离重跑通过，非回归）
- `git diff --check`：0

### browser-use 真实验收（隔离 OPENCOLORFUL_HOME，supervisor :4399 + agent server :4310）

- /logs 六 tab 全部渲染；活动表含真实行（system.started 33ms、supervisor.health.recovered、agent.migration.completed）
- 详情面板：actor/executor/target/session/errorCode/retryable/traceId/operationId/生产者 + 脱敏 payload；trace 树 8 span + linked graph（无关联提示）
- 实时跟随开关、过滤栏（事件名/类别/级别/状态/Session/Agent/搜索/时间范围）可用
- 原始日志：加载真实 JSONL 尾部（行数/字节元信息）；**验收发现并修复 main 文件过滤 bug**（`.debug.jsonl` 误匹配 main filter）
- 诊断导出：真实生成 bundle（manifest privacy 三标志 false、无 payloadJson/summaryCode/凭据，文件级验证通过），export 事件 + audit 镜像落库
- 安全审计：epoch 过滤 + 只读 + 空状态；性能：按日聚合柱状
- 移动端 390px：scrollWidth=clientWidth，无横向溢出
- Settings 日志与诊断 section →「打开完整日志工作页 →」→ 跳转 /logs ✓
- 清理：supervisor/agent server 已停止，临时 HOME 已删除

### 已知偏差

1. **audit 镜像 decision 固定 allowed**：insertAuditMirror 的 decision 恒为 'allowed'（镜像语义=事件发生证据，denied 语义由 activity 行 status 表达）。
2. **migration 失败链路**：迁移失败时 DB 不可用，无持久化通道可写 storage.migration.failed——由进程退出码 + supervisor 侧 health.degraded + 下次启动 recovery 表达（T4 起代码注释说明）。
3. **layer_changed 保持 transport-only**：memory.recall/agent.layer_changed 不进 Activity（目录无注册项，instrument 会拒绝）。
4. **spool 布局**：`logs/emergency/<channel>-<processType>-<bootId>-<seg>.jsonl` 平铺（计划写子目录，channel 已编码在文件名，功能等价）。
5. **诊断预算前端展示**：服务端未下发预算字段，前端用与服务端一致的 500MB 常量计算 80% 阈值。
6. **runRetention 的 logBytesFreed 精确性**：按文件级统计（enforceRetention 删除前后文件差异）。
7. **e2e 端口抢占 flake**：并行 worker 的 freePort TOCTOU 导致 server-start 类用例偶发失败（隔离重跑通过），属既有测试基建问题。
8. **tool.approval.*** 暂无发射方**：平台无交互式工具审批流，拒绝语义由 sandbox deny + tool.call.denied 表达（目录已注册备用）。

### 测试数量统计（Phase 11 新增）

- server unit/integration：+73（contract 9、runtime 16、store 18、instrument 12、query 8、extension-port 8、retention 5、server 集成 3+9）
- web：+13 单测 + 7 e2e
- 全量：742（server）+ 348（web）+ 52（e2e）

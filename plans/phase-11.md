# Phase 11：完整日志系统与统一可观测性

**状态：已评审修订（2026-08-01），待开发** | 建议分支：`phase-11-observability`
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
- 不宣称安全审计可以对抗拥有本机文件系统权限的用户；本阶段只保证应用层 append-only、完整性检查和明确清理语义；
- 不做 Electron 专属日志能力，保持 Server/Web-first；
- 不实现基于日志的自动调参、自我修复或 Agent 自主读取系统日志。

---

## 二、核心架构决策

### 2.1 一套语义，三条独立通道

| 通道 | 目的 | 权威存储 | 可靠性 | 默认保留 |
|---|---|---|---|---|
| `diagnostic` | 开发排错、堆栈、模块运行细节 | 每进程独立 JSONL | best effort | trace/debug 7 天；info+ 30 天 |
| `activity` | 有意义的系统状态变化与执行历史 | SQLite `activity_events` | at least once | routine 180 天；notable 2 年；milestone 长期 |
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

建议在现有 `metadata.sqlite` 中新增结构化活动表，通过 **migration v7** 加入（Phase 10 已占用 v6，本阶段在其上增量迁移）。常用查询字段独立成列，完整安全 payload 保存为 JSON。`search_text` 复用 Phase 10 记忆系统的 CJK 2/3-gram 工具生成，不平行实现第二份分词。

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
producer_component / boot_id
search_text / payload_json
```

索引至少覆盖：

```text
recorded_at
owner_agent_id + recorded_at
session_id + recorded_at
trace_id
operation_id
event_name + recorded_at
status + recorded_at
level + recorded_at
plugin_id + recorded_at
```

可使用 FTS5 索引已脱敏的 `eventName/component/errorCode/short summary`，不将 payload 全量送入 FTS。

### 5.3 `audit_events`

独立 append-only Store 与表：

```text
id / event_id / recorded_at
action / decision / reason_code
actor_kind / actor_id
executor_kind / executor_id
target_kind / target_id
owner_agent_id / session_id
trace_id / operation_id
policy_version
before_revision / after_revision
changed_fields_json / payload_json
```

业务层只暴露：

```text
append / get / list / export
```

不暴露单条 update/delete。可预留 `previousHash/recordHash` 做完整性校验，但本阶段不宣称可对抗本机所有者篡改。

### 5.4 可靠性等级

| 通道 | 策略 |
|---|---|
| diagnostic | best effort；失败 fallback stderr；允许按优先级丢弃 |
| activity routine | 有界队列 + batch；数据库失败进入 emergency spool |
| activity notable/milestone/terminal/error | 同步或优先持久化；at least once；`eventId UNIQUE` 去重 |
| audit | SQLite 或 emergency spool 至少一个成功，否则高风险操作拒绝 |

应急路径：

```text
logs/emergency/activity-spool.jsonl
logs/emergency/audit-spool.jsonl
```

启动时：

1. 读取 spool；
2. 校验、再次脱敏；
3. 按 `eventId UNIQUE` 幂等导入；
4. 全部成功后原子归档/删除；
5. 导入失败暴露 degraded health，不阻塞普通 Session 恢复。

### 5.5 事务与文件操作

- 同一 SQLite 内的领域修改与 audit insert 必须在同一事务；
- 文件类修改使用 `started → atomic temp/rename → completed`，保存 before/after revision；
- 启动恢复检查旧 `bootId` 的未终结高风险 operation，读取目标 revision 后补写 completed/failed/interrupted；
- 外部 API 无法本地事务化，只记录真实 started/terminal 与远端结果摘要；
- 审计完全无法持久化时，删除、权限、记忆审批、强度修改、插件授权等高风险操作 fail closed。

### 5.6 持久化后广播

结构化 activity/audit 的实时链路：

```text
上下文注入 → schema 校验 → 脱敏 → SQLite/spool 持久化
→ Replay Store → SSE 广播 → Web
```

禁止先广播后落盘。SQLite 查询 cursor 使用自增 `id`，诊断文件 tail 使用字节 cursor。

平台级 observability 实时事件（`observability.activity.appended` / `observability.audit.appended` / `observability.health.changed`）不属于任何 Session stream：

- activity 与 audit 各使用一个保留 streamId（`platform-observability-activity` / `platform-observability-audit`）；
- sequence 直接采用对应表的自增 `id`，满足同 streamId 从 1 严格递增；SSE 与 WS 共享同一 Replay Store；
- `observability.health.changed` 先落为一条 activity 记录再广播，同样获得持久化 sequence；
- 断线重连由客户端以 SQLite cursor（自增 id）重建，不依赖内存 replay 补间隙。

---

## 六、第一批事件目录

### 6.1 平台、Supervisor 与存储

```text
system.starting / started / stopping / stopped / crashed
system.recovery.started / completed / failed
supervisor.server.started / stopped / restarted / crashed
supervisor.health.degraded / recovered
storage.database.opened / failed
storage.migration.started / completed / failed
storage.repair.started / completed
storage.corruption.detected
storage.write.failed
```

正常健康检查成功和普通 SQLite 查询只进入 debug 或不记录；状态变化才进入 activity。

### 6.2 Agent 与 Session

```text
agent.created / started / stopped / archived / deleted
agent.base_color.changed
agent.settings.changed
agent.workspace.changed
agent.migration.completed / failed

session.created / bound / opened / archived / unarchived
session.compaction.started / completed / failed
session.recovery.completed / failed
```

底色、工作目录、沙箱、Provider 和模型设置变更记录字段名与 revision，不保存完整配置正文。

### 6.3 Turn、模型和 Provider

```text
turn.started / completed / failed / cancelled
model.call.started / completed / failed / cancelled
model.call.retrying / rate_limited
model.fallback.selected
provider.configured / tested / degraded / recovered
provider.credential.changed
```

模型完成指标：provider/model、duration、TTFT、Token usage、finish reason、attempt；不记录凭据、完整 Prompt、完整回复或原始 Provider body。

### 6.4 工具、工作区与沙箱

```text
tool.call.started / completed / failed / cancelled / denied
tool.approval.requested / granted / denied
workspace.changed
workspace.operation.failed
sandbox.path.denied
sandbox.command.denied
sandbox.policy.changed
sandbox.context.missing
sandbox.guard.failed
```

每个工具定义独立安全摘要；禁止通用记录完整 `args/result`。

### 6.5 记忆系统

```text
memory.summary.started / completed / degraded / failed
memory.compile.started / completed / failed
memory.recall.started / layer_changed / completed / empty / failed / cancelled
memory.batch.sealed / processing / deferred / completed / failed
memory.proposal.created / approved / rejected / conflicted
memory.strength.changed
memory.fact.superseded / forgotten / suppressed
memory.scheduler.deferred / recovered
```

记忆审批、遗忘、suppression、永久晋升和强度变化同时进入 audit。日志只保存 memory/proposal/batch ID、revision、强度变化和 reasonCode，不保存完整记忆正文。

### 6.6 API、SSE、WS 和 Web

```text
api.request.failed
api.validation.failed
sse.connected / disconnected / replay.reset
ws.connected / disconnected / reconnected / protocol.failed
client.unhandled_error
client.render.failed
```

不记录每个成功 HTTP 请求、每个 SSE chunk、普通 React render 或用户输入内容。Web 错误上报仅发往本机 Server（`POST /api/observability/client-events`），有速率限制，producer 与身份字段由平台重新盖章，客户端不可自填。

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

插件 manifest 声明事件 schema，但平台注入 eventId、recordedAt、actor、executor、scope、trace、producer；插件不能直接写 Store 或伪造权限结果。stdout/stderr 由平台捕获、脱敏、限长、折叠和限速。AsyncLocalStorage 不跨进程：插件/worker/IPC 边界必须显式传递 trace 上下文，由平台入口重新盖章。

### 7.3 Subagent

平台自动记录：

```text
subagent.delegated / started / processing
subagent.completed / failed / cancelled / interrupted
```

当前 Turn 内 subagent 继承父 trace 并建立子 span；独立后台 subagent 建立新 trace，并通过 `linkedTraceIds` 指向来源。活动使用 `ownerAgentId` 归入永久 Agent，不把临时 subagent 当作持久 Agent 身份。

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

日志清理、保留策略修改、诊断导出和 audit reset 本身进入 audit。用户可显式清理本地数据，但必须看到预计释放空间和影响范围。

---

## 十、查询、健康与实时接口

建议 API：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/observability/activity` | 活动查询、cursor 分页和过滤 |
| GET | `/api/observability/activity/:eventId` | 单条活动详情 |
| GET | `/api/observability/traces/:traceId` | 完整 trace/span 树 |
| GET | `/api/observability/audit` | 安全审计查询 |
| GET | `/api/observability/diagnostic/tail` | 指定进程/文件的脱敏 tail |
| POST | `/api/observability/client-events` | Web 客户端错误上报（速率限制，平台重新盖章 producer/身份字段） |
| GET | `/api/observability/metrics` | 派生指标和趋势 |
| GET | `/api/observability/health` | writer、队列、spool、磁盘与丢弃状态 |
| GET/PUT | `/api/preferences/observability` | 级别、保留期和大小上限 |
| POST | `/api/observability/export` | 生成脱敏诊断包 |
| POST | `/api/observability/retention/run` | 手动执行清理/聚合 |

activity 过滤条件至少包括：

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

实时事件：

```text
observability.activity.appended
observability.audit.appended
observability.health.changed
```

必须同步 Web SSE 已知事件列表；operator 日志流与 Agent 对话流分离，Agent 默认不能订阅原始日志。

### 诊断包

导出内容建议包括：

- manifest：版本、生成时间、平台、Node、schema 版本；
- 配置 shape，不含配置值和凭据；
- 最近脱敏 diagnostic tail；
- 失败/降级 activity；
- observability/memory/sandbox/scheduler health；
- migration 和数据库完整性摘要；
- 用户选择的 trace；
- privacy manifest：明确 `payloadFree=true`、`rawLogsIncluded=false`。

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

## 十二、任务拆分草案

```text
T1 契约与 migration
   Observability Envelope、三类 payload、Actor/Executor/Target/Scope/Trace
   事件目录注册表（eventName → channel/level/significance/payload schema 固定映射）
   migration v7：activity_events / audit_events / daily_metrics / observability_state / preferences schema

T2 脱敏、上下文与 logger core
   AsyncLocalStorage trace context（不跨进程）、child logger、SafeValue、Error normalize
   JSONL writer、debug/main 双文件、rotation、dedup、rate/backpressure、bootId、磁盘预算

T3 Activity/Audit Store 与可靠性
   lifecycle operation、SQLite 持久化、事务 helper、emergency spool
   recovery import、旧 boot interrupted reconcile、health

T4 现有平台核心埋点
   system/supervisor/storage/Agent/Session/Turn/model/Provider/API/SSE/WS
   移除或收拢零散 console 与 server.log

T5 工具、沙箱与记忆链路埋点
   tool lifecycle、安全摘要、sandbox audit 迁移
   Phase 10/10.5 recall/batch/scheduler/proposal/strength/recovery

T6 查询、实时流与诊断导出
   activity/audit/trace/diagnostic/metrics/health/client-events API
   write-before-broadcast、平台级保留 stream（sequence=表自增 id）、cursor、support bundle、二次脱敏

T7 Web `/logs` 工作页
   活动/错误/审计/性能/原始日志/导出
   filters、trace tree、live follow、错误与空态

T8 未来扩展接入契约
   ExtensionObservabilityPort、plugin namespace/schema、subagent trace inheritance
   fake plugin/subagent harness 验证，暂不实现真实插件/subagent

T9 retention、聚合与清理
   daily metrics、分级保留、磁盘预算、手动清理与 audit reset

T10 质量门与真实验收
   typecheck/tests/build/PI boundary/Playwright/browser-use
   脱敏攻击夹具、崩溃恢复、spool、trace 完整性、Windows 文件轮转
```

依赖关系：

```text
T1 → T2 → T3
          ├─→ T4 → T5
          ├─→ T6 → T7
          ├─→ T8
          └─→ T9
全部完成 → T10
```

---

## 十三、测试要求

### 契约与脱敏

- Envelope/payload TypeBox 正反例；
- actor/executor/scope 平台字段不可被插件覆盖；
- secret-like keys、Bearer、Cookie、URL credential、Provider key、base64、PII、路径变体；
- Error cause/stack、循环引用、深对象、长数组和超长字符串；
- 导出前二次脱敏；
- 不记录完整 Prompt、memory content、tool args/result。

### 生命周期与 trace

- started 对应唯一终态；
- 重复 terminal 幂等；
- Turn → model → tool → recall 子 span 关系；
- 当前 Turn subagent 继承 trace；后台 subagent linked trace；
- 旧 boot running 自动 interrupted；
- 并发 Session 上下文不串线。

### 存储与恢复

- activity/audit eventId 幂等；
- SQLite 事务失败回滚领域状态与 audit；
- diagnostic 文件轮转、清理和文件损坏隔离；
- activity/audit spool 写入、重启导入、重复导入、部分失败；
- spool 与数据库都失败时高风险操作拒绝；
- write-before-broadcast；cursor 不重不漏；
- Windows 不出现多进程共享轮转文件问题。

### 查询与 Web

- Agent/Session/trace/event/status/time/query 过滤；
- FTS 不索引敏感 payload；
- trace tree、实时追加、断线恢复和 reset；
- 活动、错误、审计、性能、原始日志和导出页面状态；
- 大日志文件不全量加载；
- 未知 future/plugin event 使用通用展示，不导致页面崩溃。

### 诊断包

- ZIP/目录路径不穿越；
- 文件权限与重复路径保护；
- privacy manifest 正确；
- 不包含 auth 文件、Session JSONL、memory.md、原始 Provider body；
- 导出失败不删除源日志。

---

## 十四、验收标准

- [ ] diagnostic/activity/audit 三通道职责明确，共享统一 Envelope 和 trace 上下文；
- [ ] 所有关键长任务都有 started 与唯一终态；重启后旧 running 能补为 interrupted；
- [ ] Agent/Session/Turn/model/tool/sandbox/memory 当前关键链路均能按 trace 查询；
- [ ] `ownerAgentId` 能正确归属主 Agent、记忆 Agent、未来 subagent 和 plugin 活动；
- [ ] diagnostic 每进程独立 JSONL、可轮转、可清理，不发生 Windows 共享文件轮转冲突；
- [ ] diagnostic 按级别分文件（debug 7 天 / 主文件 30 天），500MB 总预算超限按序丢弃并上报 degraded；
- [ ] activity/audit SQLite schema、索引、cursor 和 FTS 查询稳定；
- [ ] emergency spool 可恢复且幂等；日志系统 degraded 可在 health/UI 看见；
- [ ] 高风险操作在 audit 完全不可持久化时 fail closed；同库修改与 audit 同事务；
- [ ] SQLite 持久化成功后才广播实时 activity/audit；重连不重不漏；
- [ ] 平台级 observability 事件使用保留 streamId，sequence 为对应表自增 id，断线重连以 SQLite cursor 重建；
- [ ] Web 客户端错误经受限端点上报，平台重新盖章，速率限制生效；
- [ ] 隐私删除不级联清理 activity/audit，且日志不含被删对象正文；
- [ ] 日志不包含 API Key、Authorization、Cookie、完整 Prompt、完整记忆、文件内容或完整工具输入输出；
- [ ] `/logs` 页面具备活动、错误、审计、性能、原始日志和诊断导出完整状态；
- [ ] 诊断包经过二次脱敏，包含 privacy manifest，不包含原始敏感事实源；
- [ ] retention 按 significance 分级，routine 清理前形成 daily metrics；
- [ ] fake plugin/subagent 能通过统一 Observability Port 接入，不能覆盖平台权威字段；
- [ ] 日志永不自动进入 Agent 上下文或长期记忆；
- [ ] 全部质量门与 browser-use 验收通过。

---

## 十五、风险与缓解

| 风险 | 缓解 |
|---|---|
| 为追求“完整”记录原始敏感内容 | 语义完整而非 payload 完整；allowlist；写入和导出双重脱敏 |
| 日志阻塞主对话 | diagnostic best effort；routine activity batch；仅 audit/关键终态同步 |
| 日志自身故障递归刷屏 | emergency sink 不调用 logger；汇总 dropped count；健康状态独立 |
| SQLite 体积持续增长 | 不记录 token delta；分级保留；daily metrics；磁盘预算和显式清理 |
| 多进程 Windows 轮转失败 | 每进程独立文件；不共享 append handle；平台 Server 统一写 activity/audit |
| 插件伪造 actor、审批和权限结果 | 平台重新盖章；manifest schema；受限 Observability Port；审计由权限边界自动生成 |
| subagent 活动归属混乱 | actor/executor/ownerAgentId 分离；父 trace 或 linked trace |
| 日志成为记忆反馈回路 | 日志不注入、不自动提取；若未来引用必须显式 sourceType 与审批 |
| started 无终态 | ActivityOperation helper；operationId 约束；boot recovery interrupted |
| 先广播后落库导致刷新消失 | 强制 persist → replay → broadcast 顺序及集成测试 |
| 审计与文件修改无法原子 | started/completed + revision；atomic rename；启动 reconcile |
| 诊断包再次泄密 | 二次脱敏、privacy manifest、内容 allowlist、攻击夹具测试 |

---

## 十六、评审决议（2026-08-01）

1. **不与 `PlatformEventEnvelope` 合并**：共享 `ActorRef` / `EventScope` / `TraceContext` 等值类型定义；两种 Envelope 保持 transport 与证据语义分离。
2. **复用 `metadata.sqlite`**：不记 token delta 的预期事件量下足够；仅当 VACUUM、容量或查询 P99 出现实测压力时才评估拆出 observability DB。
3. **fail closed 清单冻结**：删除、权限/沙箱策略变更、记忆审批/遗忘/强度变化、插件授权、凭据变更、audit 清理。
4. **significance 由事件目录固定**：按 `eventName` 注册，调用方不可指定，防止分级失真。
5. **emergency spool 方案通过**：坏行隔离并保留原文件、按 eventId 幂等导入、health 可见。
6. **ALS 不跨进程**：PI SDK 同步回调与 timer 可被 AsyncLocalStorage 覆盖；插件/worker/IPC 边界显式传递 trace 上下文并由平台重新盖章。
7. **Phase 10/10.5 事件归属**：recall / batch / proposal / strength / scheduler 的生命周期事件升级为 durable activity（审批/遗忘/强度变化另进 audit）；`memory.recall.layer_changed` 等中间态保持纯 transport，不落 activity。
8. **`/logs` 与 Settings 边界**：Settings 仅保留级别/保留期设置、健康摘要与跳转入口；完整体验在 `/logs`。
9. **diagnostic 预算**：10MB/文件、500MB 总量，采用；按级别分文件（`*.debug.jsonl` / 主 JSONL）使 7/30 天分级保留可执行。
10. **audit hash chain**：v1 只预留 `previousHash/recordHash` 字段，不实现校验链，不宣称对抗本机所有者篡改。

---

## 实施记录

（评审通过并进入开发后回填）

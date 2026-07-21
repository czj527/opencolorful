# Agent 平台基础设施设计

## 文档状态

设计定稿（2026-07-21）。

本文件是基础设施阶段的架构依据。后续实现如果需要改变协议层、Session 身份、
传输边界或 UI 协议选型，应新增架构决策记录，而不是直接改变本文件的既有结论。

## 目标

基于 PI SDK 构建一个可持续演进的多 Agent 平台基础设施。第一阶段只实现
Server、模型配置、Agent Session、持久化、流式事件和 TUI 客户端，不实现私人
助理或 Coding Agent 的具体产品能力。

第一阶段的完成标准是：用户可以通过持久化设置配置自定义模型，启动 Server，
通过 TUI 创建或恢复 Session，发送消息，看到流式文本和工具事件，中断运行，
重启 Server 后继续原有 Session。

## 第一阶段明确不做的事情

- 不实现私人助理记忆、Heartbeat、Cron、Bridge 或主动行为。
- 不实现 Coding Agent 的 Git、LSP、专用 Prompt 和完整工作流。
- 不实现插件市场和社区插件信任模型。
- 不实现 Electron 桌面应用。
- 不要求所有代码都使用完整的测试驱动开发流程。
- 不把 TokUI 引入 Agent Runtime 作为核心依赖。

## 总体架构

平台采用 Server-first 架构。PI SDK 的所有 import 集中在一个适配层中，业务
代码不能直接依赖 PI SDK 的不稳定内部路径。

```text
TUI / Web 客户端
    │ HTTP 命令 + SSE 事件流
    ▼
Agent Server
    ├── API 与会话事件网关
    ├── Agent Runtime
    ├── Session Store
    ├── Model/Auth Store
    ├── PI SDK Adapter
    └── 内部 Event Bus
```

TUI 和 Server 即使运行在同一台机器上，也必须通过公开客户端协议通信。TUI
不能直接拿到 PI SDK 的 Session 对象并绕过 Server。

## 核心边界

### PI SDK Adapter

适配层是唯一允许直接 import PI SDK 的位置，负责：

- `createAgentSession`；
- `SessionManager`；
- `AuthStorage`；
- `ModelRegistry`；
- Provider 注册和模型解析；
- PI 内置工具；
- compaction 和 Session 历史工具；
- SDK 版本差异兼容；
- 流式事件和工具结果适配。

升级 PI SDK 时，优先只修改这一层。

### Agent Runtime

Runtime 管理一次 Agent 运行，但不负责 HTTP、WebSocket 或 UI 渲染。它负责：

- 创建和销毁 PI Agent Session；
- 接收 Prompt；
- 转发 PI 事件；
- Abort 和错误处理；
- 工具执行生命周期；
- 当前运行状态；
- 将事件交给内部 Event Bus。

第一阶段不定义私人助理或 Coding Agent Profile。可以预留 profile 字段，但不
让它影响行为。

### Session Store

Session 正文继续使用 PI 的 append-only JSONL 格式。平台不复制一份消息正文到
另一套数据库。

平台额外维护 SQLite 元数据索引，用于：

- Session ID；
- 标题；
- 工作目录；
- 使用的模型；
- 创建和更新时间；
- 当前运行状态；
- 当前流的 `streamId` 和序号；
- 归档和删除状态。

Session ID 是稳定身份，文件路径只是内部存储细节。文件迁移、归档或目录调整
不能改变 Session 的逻辑身份。

## 模型和认证

模型配置必须是用户可见、可持久化、可通过设置页面或 API 修改的配置。环境变量
只作为开发环境和迁移期间的 fallback，不能作为正常用户流程。

每个 Provider 至少支持：

- Provider ID；
- 显示名称；
- 协议/API 类型；
- Base URL；
- 模型 ID；
- 模型能力，例如文本、图片、工具调用、推理；
- API Key 或 OAuth 引用；
- 默认模型；
- 可选请求头；
- Reasoning/Thinking 配置。

实现优先复用 PI SDK 的：

- `AuthStorage`；
- `ModelRegistry`；
- Provider 注册机制；
- 模型解析和模型目录。

用户不应通过编辑源代码或设置环境变量完成常规模型接入。

## 传输设计

### HTTP

HTTP 用于请求/响应型操作：

- Server 健康检查和能力查询；
- Provider 和模型配置；
- Session 列表、创建、打开、归档和删除；
- 发送 Prompt；
- Abort；
- compact 和 branch；
- 获取历史消息和持久化资源；
- 查询 Server 生命周期状态。

### SSE

SSE 是基础聊天场景的默认单向事件通道。事件必须携带递增的序号，客户端可以
通过 `Last-Event-ID` 或 `sinceSeq` 进行重连和补发。

第一阶段的最小事件集合：

- `session.status`；
- `message.started`；
- `message.delta`；
- `message.completed`；
- `tool.started`；
- `tool.progress`；
- `tool.completed`；
- `turn.completed`；
- `run.error`；
- `session.updated`。

SSE 只负责传输，不规定具体 UI。事件中传递结构化数据，客户端决定使用普通
组件、Markdown 渲染器还是 TokUI。

### WebSocket

WebSocket 只用于需要长期双向连接、高频控制或多订阅的场景，不作为所有聊天
消息的唯一通道。

参考 openhanako 的设计，第一阶段定义以下能力：

1. **Session 订阅**：客户端订阅和取消订阅一个或多个 Session；每个订阅都按
   Session 身份校验权限。
2. **双向控制**：Abort 和 Compact 使用 WS 版本的命令，以便客户端立即得到
   接受、拒绝或已完成的明确结果。基础 Prompt 仍使用 HTTP POST。
3. **流恢复**：使用 `streamId`、`seq`、`sinceSeq`、`reset`、`truncated` 描述
   可重放事件；客户端断线后可以请求缺失事件。
4. **资源事件**：workspace 或资源发生 changed、deleted、renamed 时，向相关
   客户端广播，避免前端持续轮询。
5. **未来协作入口**：多人协作、远程控制、Bridge、终端控制等后续能力使用
   WS，但不进入第一阶段的业务实现。

内部事件必须独立于传输协议。相同事件可以投影成 SSE 或 WS，不允许核心 Runtime
直接依赖某一种网络连接。

## UI 协议和渲染层选型

### 选型结论

平台采用四层结构：

```text
PI Runtime Event
  → Platform Event Envelope（平台事件封装）
    → UI Projection
      ├─ text / markdown
      ├─ A2UI（标准结构化 UI 协议）
      └─ TokUI（Web 专用流式渲染器）
```

具体选择如下：

1. **平台事件封装由我们自己定义**：负责 Session 身份、事件序号、时间戳、
   重连、错误和权限，不依赖第三方 UI 协议。
2. **A2UI 作为长期的结构化 UI 协议**：优先用于跨客户端、可验证、可扩展的
   Agent-generated UI。当前实现目标以 A2UI v0.9.1 为基线，同时隔离版本差异，
   为未来 v1.0 留出升级空间。
3. **TokUI 作为 Web 专用渲染器**：用于高表现力的流式 Tool Call、Plan、状态卡、
   思考链和轻量交互，不成为 Runtime 的核心依赖。
4. **GenUI Protocol 暂不采用**：目前存在多个同名项目；其中独立 Widget 方案
   允许模型生成 HTML/CSS/JS，协议仍是草案，安全和生态成熟度不适合基础阶段。
   Flutter GenUI SDK 则是 A2UI 的客户端实现，不作为我们自己的后端协议。

### 为什么选择 A2UI + TokUI

| 需求 | A2UI | TokUI | 平台决策 |
|---|---|---|---|
| 跨 Web、TUI、移动端 | 强 | 主要面向 DOM | A2UI 作为通用协议 |
| 流式增量渲染 | JSONL 增量消息 | DSL 逐块 feed | 两者都支持，各司其职 |
| 组件安全边界 | Catalog 白名单 | Renderer/Handler 白名单 | A2UI 做默认安全基线 |
| Web 视觉表现力 | 依赖客户端 Renderer | 内置丰富 AI 组件 | TokUI 做 Web 投影 |
| 本地交互状态 | Data Model + Action | 命名 Handler | A2UI 用于正式交互，TokUI 限定命名动作 |
| 协议成熟度 | Google 主导，v0.9.1 可用 | MIT，v0.1.7 | 都隔离适配，不让版本泄漏到 Runtime |

这不是二选一：A2UI 定义“客户端应该渲染什么”，TokUI 优化“Web 如何快速、
有表现力地展示它”。同一个平台事件可以只投影为 A2UI，也可以同时投影为 TokUI。

### 平台事件封装

所有客户端事件都包在平台 Envelope 中：

```json
{
  "eventId": "evt-123",
  "sessionId": "session-123",
  "streamId": "stream-1",
  "sequence": 42,
  "timestamp": "2026-07-21T12:00:00.000Z",
  "type": "ui.message",
  "format": "a2ui",
  "payload": {
    "version": "v0.9",
    "updateComponents": {}
  }
}
```

文本、工具状态和 UI 消息共享同一套 `eventId`、`streamId` 和 `sequence` 规则。
因此 SSE、WebSocket、TUI 和未来移动端不需要理解彼此的传输细节。

### A2UI 设计

A2UI 消息使用 JSONL 语义，平台在 Envelope 的 `payload` 中传递单条 A2UI 消息。
第一阶段只支持经过平台审核的基础 Catalog：

- Text、Markdown、Card；
- Button、Input、Form；
- Progress、Status、Table；
- Tool Call、Plan、Attachment 的平台扩展组件。

每个 Surface 都有明确的 `surfaceId` 和 Catalog。平台维护自己的本地 Catalog，
不允许 Agent 随意加载远程 Catalog。后续可以按客户端能力协商 Catalog，但必须
经过版本和权限校验。

A2UI 用户操作映射为平台命令：

```json
{
  "version": "v0.9",
  "action": {
    "name": "submit_settings",
    "surfaceId": "settings",
    "sourceComponentId": "save-button",
    "timestamp": "2026-07-21T12:00:01.000Z",
    "context": {}
  }
}
```

Server 必须重新校验 Action 的 Session、Surface、组件、权限和参数，不能因为
客户端已经完成 Catalog 校验就直接执行副作用。

### TokUI 设计

TokUI 只作为 Web Projection。TokUI 的 DSL 可以通过 Server 根据结构化事件生成，
也可以由 A2UI Renderer 在 Web 侧转换，但第一阶段优先采用 Server 侧受控投影，
便于统一事件、权限和日志。

示例：

```json
{
  "eventId": "evt-124",
  "sessionId": "session-123",
  "streamId": "stream-1",
  "sequence": 43,
  "type": "ui.message",
  "format": "tokui",
  "payload": {
    "chunk": "[tool-call name:web_search status:running]"
  }
}
```

Web 客户端使用 `startStream()`、`feed()`、`endStream()` 增量渲染。TokUI 的默认
POST-SSE `connect()` 不作为平台唯一接入方式，避免平台协议被 TokUI 的请求格式
绑定。

TokUI 优先用于：

- Tool Call 状态和进度；
- Think/Think Chain 折叠区；
- Plan 和步骤状态；
- Agent/Subagent 状态；
- 文件、附件、引用和任务结果；
- Web 端轻量表单和快捷操作。

普通 Markdown 初期仍使用独立 Markdown Renderer。后续可以将稳定的 Markdown 子集
投影为 TokUI `md` 组件，但必须单独验证代码块、方括号和增量解析。

### UI 安全约束

- Agent 默认只能生成 A2UI Catalog 中声明的组件；
- 模型不能直接执行任意 JavaScript；
- TokUI 的 `clk`/`sub` 只能绑定预注册、带命名空间的处理器；
- 默认禁用 TokUI 的 `sandbox`、原始 HTML 和不受控 artifact preview；
- A2UI 和 TokUI 都限制消息大小、组件数量、缓冲区和嵌套深度；
- Markdown、图片、视频和 URL 必须做 XSS、协议和外链检查；
- 所有 UI Action 最终由 Server 做权限和参数校验；
- Catalog、Renderer 和 Handler 版本必须记录在 Session 事件中；
- 客户端渲染错误必须转为结构化错误事件，不能让整个 Session 崩溃。

### TUI 处理方式

TUI 不使用 TokUI，也不要求第一阶段实现完整 A2UI TUI Renderer。TUI 消费平台
结构化事件，至少显示文本、工具状态、错误、Session 状态和进度。A2UI 消息在
TUI 中可以先显示可读摘要，未来再实现终端组件映射。

## Server 生命周期

第一阶段提供 CLI：

```text
agent server start
agent server stop
agent server status
agent server logs
```

Server 运行状态记录至少包含：

- `stopped`；
- `starting`；
- `online`；
- `degraded`；
- `stopping`；
- `error`；
- PID；
- 端口；
- 版本；
- 启动错误。

在 Web UI 加入之前，CLI 是可信的生命周期控制器。

未来 Web UI 需要启动或停止 Server 时，增加固定端口的本地
`Controller/Supervisor`：

- 启动 Agent Server；
- 停止 Agent Server；
- 查询 PID、端口、版本和错误；
- 提供仅限 localhost 的控制 API。

浏览器页面不能依赖一个已经停止的 Server 来启动它自己。

## TUI 阶段

TUI 是协议客户端，同时也是低成本的集成测试工具。必须覆盖：

- Server 连接状态和健康检查；
- 从持久化设置读取 Provider/模型；
- 创建和列出 Session；
- Prompt 流式输出；
- 工具生命周期显示；
- Abort；
- 重连和流恢复；
- Server 重启后继续已有 Session。

TUI 只做朴素显示，不追求最终交互体验。它的价值是尽早验证未来 Web 使用的
真实 API。

## 文档和开发流程

项目只维护三类主要文档：

- `docs/product.md`：目标、范围和非目标；
- `docs/architecture.md`：稳定模块边界和架构决策；
- `plans/phase-xx.md`：当前阶段任务和验收标准。

验证采用风险分级：

- 模型认证、Provider 配置、Session 持久化、事件顺序、断线恢复和生命周期控制
  必须有自动化测试；
- A2UI Catalog/Action 校验、UI Projection、TokUI DSL 安全和交互处理器必须有针对性测试；
- 低风险 UI 和胶水代码使用类型检查、构建和少量 smoke test；
- 不对所有代码强制完整 TDD。

## 基础设施阶段划分

### Phase 0：骨架和协议契约

- 项目和包结构；
- 配置目录和运行时状态路径；
- HTTP API Schema；
- SSE/WS 事件 Schema；
- 平台 Event Envelope 和 UI message Schema；
- A2UI v0.9.1 基础 Catalog 草案；
- PI SDK Adapter 边界；
- CLI 命令结构；
- SQLite 元数据表结构；
- 确定性 faux-model 测试夹具。

### Phase 1：Runtime 垂直闭环

- Provider/模型设置持久化；
- AuthStorage 和 ModelRegistry 集成；
- Session 创建、列表、打开和恢复；
- Prompt 和 Abort；
- SSE 事件流；
- WS Session 订阅、Abort/Compact 控制和 stream resume；
- TUI 客户端；
- Server 重启和客户端重连 smoke test；
- A2UI Projection 最小 Spike，验证基础 Surface、Tool Call 和 Action；
- TokUI Web Projection 最小 Spike，验证 Plan 和状态卡片。

Phase 1 完成后，用户应能通过设置流程配置自定义 Provider，启动 Server，打开
TUI，发送 Prompt，看到流式文本和工具事件，中断一次运行，重启 Server，并
继续同一个 Session。A2UI/TokUI Spike 不影响核心事件协议，也不要求完成完整 Web UI。

## 后续产品层

基础设施稳定后，再在共享 Runtime 之上增加：

- Coding Agent 工具和工作区；
- 私人助理人格和记忆；
- Cron、Heartbeat 和主动任务；
- 插件系统；
- Web UI 完整交互；
- Bridge、协作和移动端。

私人助理和 Coding Agent 是否以可切换 Profile 暴露，延后到基础设施阶段完成后
再决定。

## 协议参考来源

- PI SDK：本地 `pi` 项目中的 `packages/ai`、`packages/agent`、
  `packages/coding-agent`。
- openhanako WebSocket 协议：本地 `openhanako/server/ws-protocol.ts` 和
  `openhanako/server/ws-scope.ts`。
- A2UI：<https://a2ui.org/>，当前实现基线为 v0.9.1，v1.0 作为后续升级目标。
- A2UI GitHub：<https://github.com/a2ui-project/a2ui>，Apache 2.0。
- TokUI：<https://tokui.jboltai.com/>，当前 npm 版本为 0.1.7，MIT。
- TokUI GitHub：<https://github.com/jboltai/tokui>。
- Flutter GenUI：<https://github.com/flutter/genui>，作为 A2UI 客户端 SDK 参考，
  不作为本平台后端协议。
- GenUI Protocol 草案：<https://github.com/yassinebkr/genui>，当前不纳入平台，
  因为它允许定义带客户端 JavaScript 行为的自治 Widget，且协议仍处于草案阶段。

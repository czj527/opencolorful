# Phase 2 / Phase 3 设计：真实模型、PI 工具与 Web UI

## 设计状态

已确认，2026-07-22。

本文定义 Phase 2 和 Phase 3 的范围、依赖、架构和验收边界。Phase 2 先完成真实
Provider 到 PI AgentSession 的生产闭环；Phase 3 在此基础上提供 Web UI 和独立的
本地 Supervisor。私人助理、Coding Agent Profile、多 Agent、OAuth、Electron 和远程
访问不属于这两个阶段。

## 目标

### Phase 2 目标

- 用户配置的 API Key、Provider、协议、Base URL 和模型可以驱动真实 LLM 请求；
- Server 重启后能够从持久化配置恢复模型运行时和 Session；
- PI SDK 内置工具可以在受控工作目录中执行，并通过现有平台事件流传递状态；
- TUI 可以使用真实 Provider 完成对话、Abort、Compact、工具调用和恢复；
- 不依赖真实网络的自动化测试可以覆盖 Provider、模型、工具和错误路径。

### Phase 3 目标

- Web UI 成为 TUI 之外的第一个完整协议客户端；
- Web UI 可以管理 Server、Provider、模型、Session、工作目录和工具权限；
- Web UI 可以显示真实 LLM 的文本、思考、工具调用、计划、错误和恢复状态；
- Agent Server 停止时，Web 仍由 Supervisor 提供，并能从页面启动或停止 Agent Server；
- Web UI 的默认布局是可收起侧栏的三栏工作台。

## 总体架构

```text
ProviderStore / AuthStorage
          |
          v
      ModelService
          |
          v
   PI ModelRuntime + Model
          |
          v
   PI AgentSession + SessionManager
          |
          v
   PlatformEventMapper
          |
          v
      ReplayStore
       /       \
      v         v
    SSE        WS
     |          |
    TUI      React Web UI
                  ^
                  |
             Supervisor
```

平台继续遵守 Phase 0/1 的边界：业务代码不直接 import PI SDK，PI JSONL 是消息正文
唯一事实来源，SQLite 只保存平台元数据，SSE/WS 共享 ReplayStore，UI 投影不能修改
Runtime 事件。

## 关键决策

### 真实 Provider

Phase 2 只做 API Key 认证。用户输入的 API Key 通过 PI `ModelRuntime` 的
AuthStorage 保存；`providers.json` 只保存 Provider 描述和 `credentialRef`，API 响应、
日志和 Session JSONL 不得出现 Key。

Provider 使用当前已支持的协议集合：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`
- `mistral-conversations`
- `pi-messages`

平台通过 `ModelRuntime.registerProvider()` 注册用户配置，使用
`ModelRuntime.getModel(providerId, modelId)` 取得 PI Model，再把它传给
`createAgentSession()`。平台不重新实现 HTTP 请求、流式解析、重试或 Provider 协议。

### PI 内置工具

工具由 PI SDK 按名称构造，使用 `createAgentSession({ cwd, tools })`：

| 权限模式 | 工具 |
|---|---|
| `off` | 无工具 |
| `read-only` | `read`、`grep`、`find`、`ls` |
| `all` | `read`、`grep`、`find`、`ls`、`write`、`edit`、`bash` |

`all` 模式必须绑定一个经过路径规范化的工作目录，并由用户在 Session 级别确认一次。
后续同一 Session 中的写入和 Bash 不逐次弹窗；切换工作目录、重新授权或新建 Session
时必须重新确认。Phase 2 不实现逐次审批，但保留未来 approval gateway 所需的工具
事件和权限字段。

所有工具执行事件继续映射为平台 `tool_start`、`tool_delta`、`tool_end` 事件。工具
参数和结果需要脱敏、截断并禁止把凭据写入事件或日志。

### Web UI 与 Supervisor

Phase 3 引入 React + Vite workspace，但 Agent Server 仍是独立 Node 进程。Supervisor
固定监听 loopback 端口，提供：

- Web 静态资源；
- Agent Server 的启动、停止、重启；
- Server 状态、端口、版本、延迟和日志摘要；
- 前端到 Agent Server 的代理或地址发现。

Supervisor 不负责 Agent Runtime、Provider、Session 或消息事件。Agent Server 停止后，
Supervisor 和 Web 页面继续可用；页面可显示 stopped/starting/online/degraded/error，
并重新连接 Agent Server。

Web 默认采用三栏工作台：

- 左侧 Session 列表、新建、归档和搜索；
- 中央聊天流、输入框、Markdown、thinking、tool call、Plan 和错误；
- 右侧 Server、Provider、模型、工作目录、工具权限和当前运行状态。

左右侧栏可分别收起；两侧都收起后，中央区域变为聊天优先布局。移动端适配只做基本
响应式约束，不在 Phase 3 设计独立移动端导航。

### UI 协议

- 普通文本由 Web React 层渲染 Markdown；
- Tool Call、Plan 和状态优先消费已有 TokUI 投影；
- A2UI 使用现有固定 Catalog 和 v0.9.1 Envelope；
- 未知或校验失败的 UI payload 只显示安全错误，不阻塞文本流；
- Web 不能自行解释或执行模型生成的 HTML、JavaScript 或远程 Catalog。

## Phase 2 范围

### P2-01：真实模型运行时

把 `ModelService` 的 Provider 配置接入真实 PI `ModelRuntime`，为每个持久化 Session
解析模型、认证和模型能力；重启后从磁盘重新构建，不依赖进程内 faux 状态。

### P2-02：真实 AgentSession 与 SessionRuntime

将当前 faux 专用 `SessionRuntime.create()` 拆成真实模型创建路径和测试 faux 路径；两者
共享 PI SessionManager、事件映射、ReplayStore、Abort 和 Compact 行为。

### P2-03：工具权限与工作区

增加 Session 工具模式、工作目录和授权状态的持久化字段；对路径做 realpath 和边界
校验；按权限模式构造 PI 内置工具；完整模式必须在创建或更新 Session 时确认。

### P2-04：真实错误与运行控制

覆盖未配置凭据、无效模型、Provider 4xx/5xx、超时、流式中断、限流、Abort 和
Compact；将 Provider 错误转换为稳定 `ApiError`，不泄露请求头或凭据。

### P2-05：TUI 与端到端验收

增加本地可控 HTTP Provider fixture，验证配置、真实 PI 请求、工具执行、Session 重启、
SSE/WS 恢复和 TUI 展示。默认测试不得访问外部 Provider 网络；真实 Provider 只作为
手动验收步骤。

## Phase 3 范围

### P3-01：Supervisor

实现固定 loopback 端口的本地 Supervisor，复用现有 Server 生命周期逻辑，处理
Windows/Linux 的进程启动、停止、重启、状态、日志和孤儿进程清理。

### P3-02：React/Vite workspace

引入最小 workspace 结构，共享平台契约类型；Web 客户端实现 HTTP API、SSE 解析、WS
订阅、`Last-Event-ID` 恢复和统一连接状态机。

### P3-03：三栏工作台

实现 Session 列表、聊天流、输入与 Abort、Provider/模型选择、Server 状态、工作目录
和工具权限控制。侧栏折叠状态只属于客户端偏好，不写入 Session JSONL。

### P3-04：工具和 UI 投影

展示工具参数摘要、运行中、结果、失败和被权限拒绝状态；接入 TokUI/A2UI 安全投影；
未知事件保持 sequence 前进但不执行未知内容。

### P3-05：浏览器验收

使用真实本地 Provider fixture 和 Playwright 验证 Supervisor 启停、Provider 设置、
Session 新建/恢复、真实流式对话、PI 工具调用、断线恢复、Abort、Compact 和侧栏折叠。

## 不在范围内

- OAuth 和第三方网页登录；
- 私人助理人格、记忆、Cron 和主动任务；
- Coding Agent 专用 Profile；
- 多 Agent、Subagent、Swarm、Bridge 和插件市场；
- Electron、系统服务和云端同步；
- LAN/远程访问和账号认证；
- 逐次工具审批、沙盒和容器隔离；
- 任意模型生成的 HTML/CSS/JavaScript Widget。

## 完成定义

Phase 2 完成时：真实 API Key Provider 可以通过 TUI 配置，真实 LLM 可完成 Prompt、
Abort、Compact、Session 恢复和 PI 内置工具调用；`npm run check`、本地 Provider fixture
和重启 E2E 全部通过。

Phase 3 完成时：Web UI 通过 Supervisor 启动，Agent Server 可从页面启停；三栏工作台
可配置 Provider、管理 Session、进行真实流式对话、显示工具状态、切换工具权限并在
断线或 Server 重启后恢复；Playwright 浏览器验收和完整质量门通过。

## 后续入口

本设计批准后，分别编写：

- `plans/phase-02.md`
- `plans/phase-03.md`

两份计划保持独立提交和独立验收；Phase 3 只能在 Phase 2 的真实模型闭环通过后开始。

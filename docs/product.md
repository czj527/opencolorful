# person-Agent 产品说明

## 产品愿景

person-Agent 是一个本地优先、可扩展、支持多种客户端的 Agent 平台。它不是某个
单一助手的实现，而是一套可以承载私人助理、Coding Agent 和未来多 Agent 协作的
稳定基础设施。

## 当前要解决的问题

现有开发尝试容易在以下位置反复重做：

1. 模型接入只依赖环境变量，没有完整的用户设置和持久化流程。
2. Session 创建后无法可靠恢复，或者 UI、Server 和 SDK 分别维护不同状态。
3. 流式消息直接绑定某个前端实现，换客户端时需要重写 Runtime。
4. 一开始同时实现记忆、多 Agent、Web、插件和自动化，导致范围失控。
5. 文档和测试要么过重，要么不足以让后续 AI 接续工作。

## 产品原则

### 成熟能力优先复用

Provider、模型目录、OAuth、API Key、Agent Session、工具调用、上下文压缩和
JSONL 会话优先使用 PI SDK。只有当 SDK 缺少产品层能力时才在平台实现。

### Server-first

Agent Runtime 由独立 Server 持有。TUI、Web、未来移动端和外部 Bridge 都是
客户端，不直接拥有 PI Session。

### 本地优先

模型凭据、Session、配置和运行日志默认保存在用户本机。远程连接和云同步属于
后续可选能力。

### 协议与渲染分离

Runtime 输出结构化平台事件。A2UI 承载标准结构化 UI，TokUI 优化 Web 流式
体验，TUI 使用终端渲染器。任何单一 UI 框架都不能成为 Runtime 的内部协议。

### 逐阶段交付

每个阶段必须形成一个可运行、可测试、可回退的闭环。未进入当前 Phase 的能力
不预先实现。

## 第一阶段用户旅程

### 配置模型

1. 用户启动本地 Server。
2. 用户通过 CLI/TUI 设置 Provider、协议、Base URL、模型 ID 和 API Key。
3. 配置写入持久化存储。
4. Server 验证配置并返回可选择模型列表。
5. 后续重启不需要重新输入。

### 创建并继续会话

1. 用户从 TUI 创建 Session。
2. 用户发送消息并看到流式响应和工具状态。
3. 用户关闭 TUI 或重启 Server。
4. 用户重新打开 TUI，选择原 Session 并继续对话。

### 中断和恢复流

1. 用户在生成过程中执行 Abort。
2. Server 明确返回 accepted、already-stopped 或 rejected。
3. 客户端短暂断线后使用 `streamId` 和 `sequence` 补取缺失事件。

## 当前范围

- 自定义 Provider 和模型设置；
- API Key/OAuth 存储适配；
- Session 创建、列表、打开、归档和恢复；
- PI Agent Runtime；
- HTTP、SSE 和必要的 WebSocket 控制；
- TUI 客户端；
- A2UI/TokUI 投影验证；
- 本地 Server 生命周期管理。

## 当前非目标

- 私人助理记忆、人格和主动行为；
- Coding Agent 专用工具链；
- 多 Agent 编排；
- Bridge 和移动端；
- 插件市场；
- Electron；
- 云端账号和跨设备同步；
- 任意模型生成 HTML/JavaScript 的自治 Widget。

## 后续方向

基础设施稳定后，按独立 Phase 增加：

1. Coding Agent 工作区和安全工具；
2. 私人助理记忆和自动化；
3. Web UI；
4. 多 Agent 通信与工作流；
5. 插件、Bridge 和移动端。

## 基础设施完成标准

- 自定义 OpenAI-compatible 或 Anthropic-style Provider 可通过设置完成接入；
- 凭据不出现在普通日志和 Session JSONL 中；
- Session 在 Server 重启后可以继续；
- SSE 事件严格按序且可以补发；
- Abort 有明确结果并停止当前 PI 运行；
- TUI 不直接 import PI SDK；
- A2UI/TokUI 不改变平台核心事件协议；
- `npm run check` 和集成 smoke test 通过。


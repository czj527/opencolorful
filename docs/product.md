# OpenColorful 产品说明

## 产品愿景

**OpenColorful = 承载 agent 完整一生的本地优先平台基础设施。**

核心理念：给每个 agent 完整的一生。agent 不只是"有用的工具"——它有自我（人格、性格、记忆、想法）、有成长、有生活、有社交。它的职业形态（coding 工程师 / 设计师 / 文档撰写员 / 陪伴朋友）由创建者通过插件特化决定，平台不预设 agent 是什么。我们关注 agent 的"自我"，而非市面 agent 追求的"有用性"。

三层架构：① Agent 生命基础设施层（自我：人格/记忆/成长/生活/社交）② 形态特化层（插件化交互基础设施）③ 生态流转层（角色卡一生档案/市场/Bridge）。

> 完整定位与路线见 [positioning-and-roadmap.md](positioning-and-roadmap.md)；基础设施边界与选型见 [infrastructure-decisions.md](infrastructure-decisions.md)。本文档为历史产品说明，如与上述两文档冲突，以它们为准。

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

## 当前阶段范围

**Phase 8 已完成（2026-07-28）：**
- Agent 身份去 `type` 枚举，采用 `identity.json` version 2；
- 人格配置命名为"底色"，独立存储为 `base-color.json`，运行设置存储为 `settings.json`；
- 5 个颜色模板只用于创建时初始化底色，创建后 Agent 与模板完全脱钩；
- Agent 创建/编辑与新会话创建使用独立页面，新会话可选择绑定 Agent 并继承其默认工作目录；
- Windows 使用原生文件夹选择器，Session 在发送首条消息时才创建。

**下一阶段核心目标（Phase 9-10，生命基础设施层的"自我"层）：**
- 沙箱机制（能力声明 + 执行边界 + 应用层 PathGuard）；
- 记忆系统（案头/笺/今日记/往事/识见/手艺/梦境）；
- 结构化日志框架 + 关键行为埋点。

Phase 8 未实现 yuan 持久化引用、capabilities、skills、scene、记忆或插件；这些能力继续按后续 Phase 单独讨论和建模。

**暂不做（等自我层稳定）：**
- Electron 桌面端（Phase 10-11 后产品化阶段）
- 形态特化层（coding/design 专用交互基础设施，需插件系统就绪）
- 技能自创、性格自我演变（风险极高，yuan 作稳定锚点不漂移）
- 云端账号和跨设备同步
- 任意模型生成 HTML/JavaScript 的自治 Widget

## 后续方向

生命基础设施层稳定后，按 Phase 推进（详见 positioning-and-roadmap.md 第五章）：

- Phase 11：skills2set 技能包（场景特化载体）
- Phase 12：插件系统（PluginContext + 两级权限 + bundle/code 二分）
- Phase 13：多 Agent 协作（ACP 协议 + GraphRuntime 图编排）
- Phase 14：Bridge + 案头/笺 + 定时任务 + 角色卡一生档案
- 后续：形态特化层（coding/design 专用交互基础设施）、Electron 产品化

## 基础设施完成标准

- 自定义 OpenAI-compatible 或 Anthropic-style Provider 可通过设置完成接入；
- 凭据不出现在普通日志和 Session JSONL 中；
- Session 在 Server 重启后可以继续；
- SSE 事件严格按序且可以补发；
- Abort 有明确结果并停止当前 PI 运行；
- TUI 不直接 import PI SDK；
- A2UI/TokUI 不改变平台核心事件协议；
- `npm run check` 和集成 smoke test 通过。

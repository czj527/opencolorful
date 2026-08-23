<p align="center">
  <img src="desktop/public/assets/window-desk.png" width="100%" alt="OpenColorful 工作台概念图">
</p>

<h1 align="center">OpenColorful</h1>

<p align="center">本地优先的个人助理 Agent 与个人效率工作台</p>

<p align="center">
  先把个人助理做得好用，再让人与 Agent 在同一个工作台里协作。
</p>

<p align="center">
  <a href="https://github.com/czj527/opencolorful/blob/main/LICENSE">MIT License</a>
  ·
  <a href="https://github.com/czj527/opencolorful/blob/main/docs/project-status.md">项目状态</a>
  ·
  <a href="https://github.com/czj527/opencolorful/blob/main/CONTRIBUTING.md">参与开发</a>
</p>

---

## OpenColorful 是什么

OpenColorful 面向普通电脑用户，目标是提供一个真正可用、可控、可恢复的个人助理 Agent。

它不是只面向 coder 的 Coding Agent，也不是把“Agent 拥有完整生活”当作今天已经解决的问题。我们参考 openhanako 的个人助理方向，先把记忆、人格、文件、工具、技能和日常工作流程做扎实。

更远期，“给 Agent 完整的一生”会作为长期愿景；当前版本优先解决真实的个人工作问题。

## 当前能力

OpenColorful 目前处于早期公开开发阶段，已经具备一套较完整的 Agent 平台底座：

- Agent 身份、人格底色、运行设置和工作目录；
- Provider、模型、凭据隔离和 Session 生命周期；
- Memory、主动回想、后台整理和只读查询；
- 文件工具、PathGuard 应用层沙箱、权限和审计；
- Plugin Protocol、Plugin Runtime、SDK 和受控扩展点；
- Agent Skills 兼容、Bundle、绑定、安装和 turn snapshot；
- 临时 Subagent Runtime、父子任务协议和生命周期日志；
- Server-first Runtime，提供 HTTP、SSE、WebSocket 和 TUI 接入；
- Electron + React 桌面端原型；
- Web 运维客户端和 Playwright 浏览器验收环境。

这些能力代表平台底座已经形成，不代表个人助理产品体验已经完成。我们正在把它们收敛成普通用户可以直接使用的工作流。

## 我们正在做的产品

### 个人助理 Agent

近期目标是对标 openhanako 已经验证的个人助理能力：

- 记住经过确认的用户信息和工作上下文；
- 处理文件、资料和常见办公任务；
- 使用受控工具完成检索、整理、执行和反馈；
- 通过 Skill 和 Plugin 扩展能力；
- 提供提醒、后台任务和有限的主动行为；
- 用清晰的状态、权限和错误解释保护用户控制权。

### 人与 Agent 共用的工作台

这是 OpenColorful 的主要差异化方向。

用户和 Agent 将作为工作台中的两个同级参与者：

- 用户管理自己的项目、任务、笔记和日程；
- Agent 管理自己的会话、记忆、任务和工作空间；
- 项目可以关联 Agent、会话、文件、任务和运行记录；
- 日程以日历或日程表呈现，而不仅是聊天里的提醒；
- Agent 的结果可以回到项目和日程中，而不是停留在聊天记录里。

项目管理、日程管理和完整的用户/Agent 工作台仍在建设中，不把规划内容冒充成当前功能。

## 为什么本地优先

- 数据和 Session 保存在本机，用户拥有自己的运行环境；
- Server、Web、Desktop 通过稳定协议协作，客户端不直接绕过 Runtime；
- API Key 进入专用凭据存储，不写入普通配置或日志；
- 工具能力受沙箱、权限快照和审计边界约束；
- 事件先进入 Replay Store，再发送到客户端，支持恢复和诊断。

## 快速开始

### 环境

- Node.js 22.19 或更高版本
- npm Workspaces
- Windows、macOS、Linux；当前主要在 Windows 上验证

### 安装与质量检查

    npm install --legacy-peer-deps
    npm run check

npm run check 会检查文档治理、PI/Plugin import 边界、插件包构建、TypeScript、后端测试、Web 测试、Web 构建和 Desktop 构建。

### 启动 Agent Server

    $env:OPENCOLORFUL_HOME = "$PWD\\.opencolorful"
    npm run cli -- server start
    npm run cli -- server status

默认监听 127.0.0.1:4310，健康检查地址为：

    http://127.0.0.1:4310/api/health

### 启动 Web 或 Desktop

    npm run web:build
    npm run cli -- supervisor start

    npm run web:dev

    npm run desktop:dev

生产构建：

    npm run desktop:build
    npm run desktop:start

Web 是当前的运维与浏览器验收客户端；Desktop 是正在发展的主要产品前端方向。

## 架构简表

    desktop/          Electron + React 桌面工作台
    web/              浏览器运维与测试客户端
    src/server/       Hono HTTP、SSE、WebSocket 和 API 路由
    src/runtime/      Session、Memory、Plugin、Skill、Subagent
    src/storage/      SQLite 元数据、索引和状态
    src/sandbox/      PathGuard 应用层沙箱
    src/observability/Diagnostic / Activity / Audit / Trace
    src/pi-sdk/       唯一的 PI SDK 适配边界
    packages/         Plugin Protocol、SDK、Runtime、Components

关键边界：

- PI SDK 只从 src/pi-sdk/ 接入；
- PI JSONL 保存消息正文，SQLite 保存元数据和索引；
- 跨进程数据先定义契约，再由 Server、Web 和 Desktop 消费；
- 默认只监听 127.0.0.1；
- Plugin、Skill 和 Subagent 能力必须经过权限和审计边界。

## 路线

| 轨道 | 目标 | 状态 |
|---|---|---|
| Governance G0 | CI/CD、文档治理、分支保护和可复现发布 | 进行中 |
| Product P1 | 对标 openhanako，补齐个人助理垂直切片 | 规划中 |
| Product P2 | 项目、任务、资料和日程工作台 | 未排期 |
| Product P3 | Plugin/Skill 生态、Bridge 和更成熟的协作 | 未排期 |
| Research R1 | Cordis 化、自扩展和更长期的 Agent 成长 | 远期研究 |

## 文档

- [当前项目状态](docs/project-status.md)
- [产品定位与路线](docs/positioning-and-roadmap.md)
- [架构说明](docs/architecture.md)
- [桌面端设计系统](docs/design.md)
- [开发流程与质量门](docs/development.md)
- [文档治理](docs/document-governance.md)
- [CI/CD 流程](docs/ci-cd.md)
- [发布流程](docs/release.md)
- [阶段计划](plans/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

## 参考项目

- [openhanako](https://github.com/liliMozi/openhanako)：个人助理 Agent 的主要产品参考；
- [openclaw](https://github.com/openclaw/openclaw)：插件、Bridge、Agent 协议和自治边界参考；
- [hermes-agent](https://github.com/NousResearch/hermes-agent)：记忆整理、Skill 和 Agent 工作流参考；
- [lobe-chat](https://github.com/lobehub/lobe-chat)：多 Agent 工作台和产品化参考；
- [codex](https://github.com/openai/codex)、[opencode](https://github.com/anomalyco/opencode)、[oh-my-pi](https://github.com/badlogic/pi-mono)：Coding Agent、Runtime 和工具编排参考。

## 参与开发

OpenColorful 处于早期公开开发阶段。开始修改前请阅读 AGENTS.md 和 CONTRIBUTING.md。提交前请运行 npm run check，并在 PR 中说明变更影响、文档收口和验证证据。

项目采用 MIT License，详见 LICENSE。

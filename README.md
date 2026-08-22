# OpenColorful

OpenColorful 是一个**本地优先的个人助理 Agent 平台与个人效率工作台**。

我们的近期目标不是让 Agent 立刻拥有“完整的一生”，而是先把一个真正好用、可控、可持续的个人助理 Agent 做完整：它能够帮助用户处理信息、文件、任务和日常工作；同时，用户和 Agent 可以在同一个工作台里管理项目、资料与日程。

OpenColorful 参考 [openhanako](https://github.com/liliMozi/openhanako) 的个人助理方向，但不把自己包装成它的替代品。**“给 Agent 完整的一生”是远期愿景，不是当前产品承诺。**

## 项目定位

### 近期目标

- 面向普通电脑用户的个人助理 Agent，而不只是 Coding Agent；
- 提供记忆、人格、文件与工作目录、工具、Skill 和 Plugin 等基础能力；
- 用沙箱、权限、审计和可恢复事件保护用户数据；
- 让用户和 Agent 各自拥有工作台，并在项目、任务、日程和资料上协作；
- 通过桌面端提供稳定、易理解的日常使用体验。

### 现实边界

API 成本、模型可靠性、自动化安全和用户心智都还在沉淀。我们不会把后台自治、主动生活或自我成长包装成已经解决的问题，也不会默认 Agent 可以自行扩大权限。当前优先级是可用、可控、可恢复。

## 我们要做的产品

### 1. 个人助理 Agent

先补齐 openhanako 已经验证过的个人助理能力：

- 人格与记忆带来的连续体验；
- 文件、工作目录和常见办公任务；
- 受控工具、Skill、Plugin 和安全审批；
- 会话管理、提醒、后台任务和有限主动性；
- 清晰的运行状态、错误解释和恢复路径。

OpenColorful 当前已有较完整的平台底座，但个人助理产品层仍在建设中。我们的阶段目标是：至少能够承担一个普通用户的日常个人助理工作，而不是只有平台 API 和测试用例。

### 2. 人与 Agent 共用的工作台

这是 OpenColorful 相对个人助理产品的核心差异化方向。

- Agent 有自己的会话、记忆、任务和工作空间；
- 用户有自己的项目、任务、笔记和日程；
- 项目可以关联 Agent、会话、文件、任务和运行记录；
- 日程以日历/日程表呈现，而不仅是聊天里的提醒；
- 用户可以查看 Agent 正在做什么、为什么这样做，以及下一步需要什么；
- Agent 的结果能够回到项目和日程中，而不是停留在聊天记录里。

我们的目标不是再做一个聊天壳，而是做一个**人和 Agent 都能工作的个人工作台**。

### 3. 远期的可扩展 Agent

更远期，我们会研究 DeepSeek Harness 提出的 Cordis 化方向，让 Agent 在约束、审查和回滚机制下，为自己编写插件、技能和工作流。

这可能涉及代码生成与测试、插件生命周期、能力快照、沙箱、用户批准和 Runtime 架构调整。它不是近期功能，也不会通过简单地给模型更高权限来实现。

“Agent 完整的一生”可以作为这条路线最终想抵达的方向，但我们会先把每一个可用阶段做好。

## 当前状态

OpenColorful 处于早期公开开发阶段。当前已经具备：

- TypeScript ESM、Node.js 22、Hono、SQLite/WAL 和 Vitest；
- Server-first Runtime，Web/TUI 通过 HTTP、SSE、WebSocket 访问；
- Provider、模型、凭据隔离和 Session 生命周期管理；
- Agent 身份、人格底色、运行设置和工作目录；
- PathGuard 应用层沙箱、工具权限和审计；
- 事件 Envelope、严格序号、Replay Store、SSE/WS 恢复；
- Memory 基础设施、主动回想、后台整理和只读查询；
- Diagnostic、Activity、Audit 三通道可观测性；
- Plugin Protocol、Plugin Runtime、SDK 和受控扩展点；
- Agent Skills 兼容、Catalog、Bundle、绑定、安装和 turn snapshot；
- 临时 Subagent Runtime、父子任务协议和生命周期日志；
- Electron + React 桌面端原型，以及浏览器 Web 运维/测试客户端。

仍在建设的产品能力包括：完整个人助理体验、稳定的记忆与日程流程、用户项目与 Agent 工作空间的统一模型、桌面端跨平台发布、外部平台 Bridge 和面向普通用户的首次启动与权限体验。

## 开发路线

### 阶段 0：仓库 CI/CD 和公开协作

- GitHub Actions 覆盖类型检查、后端测试、Web 测试、浏览器 E2E、Web 构建和桌面构建；
- 固定 Node/npm 版本和依赖安装方式；
- 让 main 保持可构建、可测试；
- 补齐贡献指南、安全政策、Issue/PR 模板、变更记录和发布流程；
- 让 Server、Web 和 Desktop 的质量门能在干净环境复现。

### 阶段 1：对标 openhanako，补齐个人助理

- 记忆与人格的日常使用体验；
- 文件、工作目录、工具和安全审批；
- Skill、Plugin 和可迁移的 Agent 配置；
- 会话管理、后台任务、提醒和有限主动性；
- 可靠的桌面端交互和运行状态反馈。

### 阶段 2：建设个人效率工作台

- 项目、任务、状态、负责人、截止时间和关联资料；
- 日历视图、日程表、提醒和重复安排；
- 用户与 Agent 同级的工作区和清晰权限；
- 从项目发起 Agent 任务，结果回写项目和日程；
- 统一搜索、活动记录和可解释的自动化历史。

### 阶段 3：扩展生态与连接能力

- Plugin/Skill 市场和可信来源；
- 角色卡、Agent 配置和 Skill Bundle 的导入导出；
- 选择性接入 Telegram、飞书等外部平台；
- 多 Agent 协作、频道和更成熟的 Subagent 编排；
- 可替换的工作台模块和领域专用工作区。

### 阶段 4：Cordis 化与远期自进化

- Agent 生成插件和技能；
- 自动测试、审查、权限申请、安装和回滚；
- 能力变更的版本化、审计和用户确认；
- 更长期的主动生活、持续成长和 Agent 个人档案。

阶段 4 属于远期研究路线，不作为当前版本的完成条件。

## 与 openhanako 的关系

openhanako 是我们的主要产品参考，尤其是在个人助理定位、人格、记忆、书桌、文件、定时任务、Skill、Plugin、多 Agent 和桌面体验方面。

OpenColorful 的路线是：

1. 先补齐个人助理的基础体验，不假装已经完成；
2. 保留本地优先、Server-first、契约、Replay、沙箱和审计等工程基础；
3. 把用户项目、任务和日程作为与 Agent 同级的一等对象；
4. 产品稳定后，再探索 Agent 自己扩展能力的安全闭环。

## 架构概览

    desktop/       Electron + React 桌面工作台
    web/           浏览器运维与测试客户端
    src/server/    Hono HTTP、SSE、WebSocket 和 API 路由
    src/runtime/   Session、Memory、Plugin、Skill、Subagent 运行时
    src/storage/   SQLite 元数据、索引和状态
    src/sandbox/   PathGuard 应用层沙箱与权限边界
    src/observability/  Diagnostic / Activity / Audit / Trace
    src/pi-sdk/    唯一的 PI SDK 适配边界
    packages/      Plugin Protocol、SDK、Runtime、Components
    tests/         后端单元、集成、契约、Smoke 和 E2E 测试
    docs/          架构、设计、产品和开发文档
    plans/         阶段计划、实施记录和验收证据

核心边界：

- PI SDK 只允许从 src/pi-sdk/ 接入；
- 消息正文由 PI JSONL 保存，SQLite 保存元数据和索引；
- 跨进程数据先定义契约，再由 Server、Web 和 Desktop 消费；
- 事件先写 Replay Store，再广播给客户端；
- API Key 不写入普通配置、Session 或日志；
- 默认只监听 127.0.0.1；
- Plugin、Skill 和 Subagent 的能力必须经过快照、权限和审计边界。

## 快速开始

### 环境要求

- Node.js >=22.19.0
- npm Workspaces
- Windows、macOS、Linux（当前主要在 Windows 上验证）

### 安装与质量检查

    npm install --legacy-peer-deps
    npm run check

质量检查覆盖 PI/Plugin import 边界、插件包构建、TypeScript、后端测试、Web 测试、Web 构建和桌面构建。

### 启动 Agent Server

    $env:OPENCOLORFUL_HOME = "$PWD\\.opencolorful"
    npm run cli -- server start
    npm run cli -- server status
    npm run cli -- server logs
    npm run cli -- server stop

默认监听 127.0.0.1:4310，健康检查地址为 http://127.0.0.1:4310/api/health。

### 启动 Supervisor、Web 和 Desktop

    npm run web:build
    npm run cli -- supervisor start

    npm run web:dev
    npm run web:test
    cd web
    npx playwright test

    npm run desktop:dev
    npm run desktop:build
    npm run desktop:start

桌面端通过 Electron 主进程访问 Supervisor/Agent Server，renderer 使用 DesktopDataSource 接口在 Mock 和 IPC 数据源之间切换。

## 文档导航

- [定位与路线](docs/positioning-and-roadmap.md)
- [基础设施决策](docs/infrastructure-decisions.md)
- [架构说明](docs/architecture.md)
- [桌面端设计系统](docs/design.md)
- [桌面端对接计划](plans/desktop-wiring.md)
- [开发流程与质量门](docs/development.md)
- [记忆系统架构](docs/memory-architecture.md)
- [日志系统架构](docs/logging-architecture.md)
- [Agent 协作指南](AGENTS.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

## 参考项目

工作区的 references/ 下的仓库只用于调研，不属于 OpenColorful 的 Git 历史：

- [openhanako](https://github.com/liliMozi/openhanako)：个人助理 Agent 的主要产品参考；
- [openclaw](https://github.com/openclaw/openclaw)：插件、Bridge、Agent 协议和自治边界参考；
- [hermes-agent](https://github.com/NousResearch/hermes-agent)：记忆整理、Skill 和 Agent 工作流参考；
- [lobe-chat](https://github.com/lobehub/lobe-chat)：多 Agent 工作台和产品化参考；
- [codex](https://github.com/openai/codex)、[opencode](https://github.com/anomalyco/opencode)、[oh-my-pi](https://github.com/badlogic/pi-mono)：Coding Agent、Runtime 和工具编排参考。

## 参与开发

OpenColorful 目前处于早期公开开发阶段。提交代码前请先阅读 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，并确保本地质量门通过。

项目采用 MIT License，详见 [LICENSE](LICENSE)。

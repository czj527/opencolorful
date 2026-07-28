# OpenColorful

承载 agent 完整一生的本地优先平台基础设施——平台提供 agent 的"自我"（人格/记忆/成长/生活/社交），agent 的职业形态由创建者通过插件特化决定，**不预设 agent 是什么**。核心理念与路线详见 [定位与路线](docs/positioning-and-roadmap.md)。

Phase 0 基础骨架已完成。Phase 1 已完成——SSE/WS/TUI/A2UI/TokUI 基础设施。
Phase 2 已完成——Provider/凭据驱动真实 LLM、PI 内置工具三级权限（off/read-only/all）、
Provider 错误映射、思考级别和真实 Provider/工具重启 E2E。
Phase 3 已完成——Supervisor 进程管理（Web 静态托管、HTTP/SSE/WS 代理、健康检查 PID 验证、
串行化 start、进程树清理）与 React Web 工作台（三栏布局、per-stream 游标、安全 Markdown、
Provider 表单配置、归档重开、真实 Abort、重启恢复、10 个 Playwright 浏览器验收测试）。
Phase 4 已完成——独立设置中心（/settings）、全局默认偏好（preferences.json）、
可调宽侧栏与 Focus 模式、Supervisor 日志过滤与增量读取、流式事件批处理渲染、
自动滚动与恢复提示。
Phase 5 已完成并通过最终验收（2026-07-25）——多 Agent 身份证系统（UUID 服务端生成）、会话可选绑定 Agent（含重启恢复）、Agent 管理设置页、亮/暗主题、聊天控制栏重构和工具卡片时间线稳定；质量门全部通过（服务端 31/209、Web 13/167），Playwright 17/17 全部通过。补充轮（5b）完成人设注入、历史卡片重建与显示开关、一体化输入框、Agent 跟随会话、主题修复与样式优化，验收全绿。
Phase 6 已完成并通过最终验收（2026-07-25）——Token 用量全链路（事件携带 usage/context → SQLite v5 幂等落库 → 统计 API → 发送按钮左侧上下文圆环/本 turn 用量行/设置中心用量统计页，不计算金额）、对话时间线导航（轮次节点点击定位高亮、显隐偏好持久化、窄屏自动隐藏）、Web 会话命令系统（`/help` `/compact` `/new` `/abort` `/clear` 面板）、compact 服务端补齐（事件广播、懒重建、生成中 409）、开发流程文档 [docs/development.md](docs/development.md)；质量门全部通过（服务端 35 文件、Web 243 用例），Playwright 23/23 全部通过。
Phase 7 已完成并通过最终验收（2026-07-25）——参考 openhanako 做前端 UI 与交互完整重构：设计令牌体系（`tokens.css` 结构令牌 + `animations.css` pa-* keyframes + `prefers-reduced-motion` 令牌兜底）、13 个 UI 原语库（`components/ui/`）、CSS Modules 全面迁移、聊天渲染/Composer/设置中心/布局壳统一采用原语与令牌、AppShell 抽出与 WorkspaceApp 瘦身 29%（677→482 行）、Modal 焦点陷阱、happy-dom + testing-library 测试基建；质量门全过，Web 278 用例、Playwright 23/23 无回归。
Phase 8 已完成（2026-07-28）——Agent 模型去枚举化（identity v2，无 `type`）、独立底色（`base-color.json`）与运行设置（`settings.json`）、旧数据迁移、5 个底色起点模板、Windows 原生工作目录选择、Agent 创建/编辑独立页面，以及带可选 Agent 绑定的新会话创建页；模板只初始化表单，不写入 Agent。具体范围、验收证据和后续留项见 [Phase 8 计划](plans/phase-08.md)。

## 开始开发

```powershell
npm install
npm run check

# 可选：把开发数据隔离在项目内（该目录已被 Git 忽略）
$env:OPENCOLORFUL_HOME = "$PWD\.opencolorful"

npm run cli -- server start
npm run cli -- server status
npm run cli -- server logs
npm run cli -- server stop
```

前台调试使用：

```powershell
npm run cli -- server start --foreground
```

默认监听 `127.0.0.1:4310`，健康检查地址是
`http://127.0.0.1:4310/api/health`。

## Supervisor 和 Web 工作台

```powershell
# 先构建 Web（Supervisor 生产模式托管 web/dist）
npm run web:build

# 启动 Supervisor（默认端口 4311，Agent Server 端口 4310）
npm run cli -- supervisor start

# 自定义端口
npm run cli -- supervisor start --port 4311 --agent-port 4310
```

Supervisor 管理 Agent Server 的生命周期（启动、停止、重启），托管 Web 静态资源，
并将非 Supervisor 的 HTTP/SSE 请求透明代理到 Agent Server；WebSocket 通过
`/ws` 代理或 `/api/supervisor/agent-server` 地址发现连接。Agent Server 停止时
Supervisor 与 Web 页面仍保持在线，可随时通过页面重新启动。

Web 工作台使用 React + Vite 构建，位于 `web/` npm workspace：

```powershell
# Web 开发模式（/api/supervisor → 4311，/api 与 /ws → 4310）
npm run web:dev

# Web 生产构建
npm run web:build

# Web 单元测试
npm run web:test

# Playwright 真实浏览器验收（需先 npm run web:build）
cd web && npx playwright test
```

### 设置中心

从工作台顶部齿轮图标进入 `/settings`，提供：

- **模型与 Provider**：管理 Provider 配置和 API Key 凭据
- **默认对话**：设置新建 Session 的默认模型、思考级别和工具模式
- **界面与布局**：侧栏宽度、动态效果偏好
- **Agent 管理**：查看 Agent 列表；从独立页面创建/编辑名称、底色和默认工作目录
- **日志与诊断**：按级别/关键词过滤 Supervisor 日志，支持增量读取
- **运行时与关于**：Supervisor 和 Agent Server 的 PID、端口、版本

全局默认值仅在创建新 Session 时应用，已有 Session 的显式设置不受影响。

点击侧栏的新建会话入口进入 `/new`：可以选择绑定 Agent 或保持未绑定，绑定后继承 Agent 默认工作目录；发送首条消息时才创建 Session，创建后 Agent 绑定不可修改。Agent 创建与编辑分别使用 `/agents/new` 和 `/agents/:id`。

## 文档

**必读（理解项目定位）：**
- [定位与开发路线](docs/positioning-and-roadmap.md) — 核心理念、三层架构、Phase 8-14 路线、差异化
- [基础设施边界与开发决策](docs/infrastructure-decisions.md) — 记忆命名体系、沙箱定位、subagent 特化、日志/Electron 时机
- [Agent 协作指南](AGENTS.md) — 自动化开发 Agent 入口

**参考：**
- [架构说明](docs/architecture.md) — 平台层技术栈/模块边界/事件协议
- [开发流程](docs/development.md) — 角色/并行/质量门
- [产品说明](docs/product.md) — 旧定位（以 positioning-and-roadmap.md 为准）
- [基础设施设计](docs/superpowers/specs/2026-07-21-agent-platform-foundation-design.md)
- [Phase 0-7 计划](plans/phase-00.md) — 已完成历史阶段
- [Phase 8 计划与验收](plans/phase-08.md) — Agent 去枚举化、底色与新会话体验

## 参考项目

`<local-workspace>\references\` 下有 8 个参考仓库（`pi` / `oh-my-pi` / `openhanako` / `openclaw` / `hermes-agent` / `lobe-chat` / `codex` / `opencode`），独立参考仓库，不属于本项目 Git 历史。各项目定位与借鉴点见 [positioning-and-roadmap.md](docs/positioning-and-roadmap.md) 第六章。

## 开发原则

- 复用 PI SDK 已有能力，不复制 Provider、Session 和工具协议。
- 所有 PI SDK import 收敛到适配层。
- 用户配置通过持久化设置完成，环境变量只作开发 fallback。
- TUI 和 Web 都通过 Server 协议访问 Runtime。
- 关键边界必须测试，低风险胶水代码不强制完整 TDD。
- 每个 Phase 都要有明确的范围、验收条件和独立提交。

## 当前状态与下一阶段

**平台层与 Agent 基础模型已完成（Phase 0-8）**：Server / Session / Provider / Supervisor / Web UI / Agent 身份证 / 底色 / Agent 工作目录 / Token 用量。

**下一阶段核心目标（Phase 9-10）**：沙箱机制 / 记忆系统（案头/笺/今日记/往事/识见/手艺/梦境），穿插结构化日志框架。Phase 8 明确不提前实现 yuan 模板层、capabilities、skills、记忆和插件系统。

**暂不做**：Electron 桌面端（Phase 10-11 后产品化阶段）、形态特化层（coding/design 专用交互基础设施）、技能自创、性格自我演变。

**仍未完成的基础项**：OAuth、逐次工具审批、LAN/远程访问、云端同步、Web 端 A2UI/TokUI 完整交互组件渲染、Supervisor 系统服务注册。

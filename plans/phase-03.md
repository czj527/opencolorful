# Phase 3：Supervisor 与 Web UI 实施计划

**状态：整改中（2026-07-22 验收不通过，标签已撤回）**

首轮验收发现 6 项阻塞问题：Supervisor 未托管 Web、核心 Web 功能未接入、
SSE/WS 协议不兼容、浏览器运行时错误、E2E 名不副实、smoke-web 进程清理失败。
正在逐项修复。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task。Phase 3 只能在 `phase-2-complete` 验收通过后开始。

**目标：** 使用 React + Vite 构建一个通过 Supervisor 管理本地 Agent Server 的三栏 Web 工作台，完整消费 Phase 0/1/2 的 Provider、Session、SSE、WS、A2UI、TokUI 和 PI 工具事件。

**架构：** Supervisor 固定监听 loopback，托管 Web 静态资源并管理 Agent Server 子进程；Agent Server 继续拥有 Runtime、数据库和凭据。Web 只通过 HTTP、SSE、WS 访问 Agent Server，默认三栏布局，左右栏可独立折叠，全部折叠后进入聊天优先模式。

**技术栈：** Node.js 22.19+、React、Vite、TypeScript、Vitest、Playwright、现有 Hono/WS/SSE Server。

---

## 完成定义

- Supervisor 在 Agent Server stopped 时仍可打开 Web；
- Web 可以显示 online/starting/stopped/degraded/error，并启动、停止、重启 Agent Server；
- Provider/API Key、模型、Session、工具权限和工作目录可在 Web 操作；
- 真实 Provider 对话通过 SSE 流式展示，WS 负责订阅、Abort、Compact 和 Resume；
- 工具模式和工作区确认遵守 Phase 2 语义；
- Tool Call、Plan、状态、A2UI/TokUI 投影安全展示；
- Server 重启或浏览器断线后，Session 历史和缺失事件可恢复；
- Playwright 浏览器验收、`npm run check`、生产构建和 smoke 全部通过。

## Task 1：Supervisor 进程与控制协议 ✅ 提交 `9dfacbc`

**Files:**
- Create: `src/supervisor/types.ts`
- Create: `src/supervisor/process-controller.ts`
- Create: `src/supervisor/app.ts`
- Create: `src/supervisor/start.ts`
- Modify: `src/config/paths.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/server-command.ts`
- Test: `tests/integration/supervisor.test.ts`

- [x] 定义 Supervisor 状态：`stopped | starting | online | degraded | stopping | error`，并定义 `GET /api/supervisor/status`、`POST /api/supervisor/start`、`POST /api/supervisor/stop`、`POST /api/supervisor/restart`、`GET /api/supervisor/logs`。
- [x] Supervisor 使用固定 loopback 端口，Agent Server 仍使用可配置端口；状态文件记录两个进程的 PID、端口、版本和更新时间。
- [x] Windows 使用隐藏子进程和明确的进程树清理；Linux/macOS 使用 detached 子进程但不注册系统服务。
- [x] 启动命令等待 `/api/health` 成功，不使用固定 sleep；失败路径关闭子进程、状态和锁。
- [x] Agent Server 停止时 Supervisor 不退出，页面请求仍返回 stopped 和最后一段脱敏日志。
- [x] 测试覆盖启动竞态、重复 start、停止活跃 Server、异常退出、孤儿 PID、端口冲突和重启。
- [x] 运行：`npx vitest run tests/integration/supervisor.test.ts`。
- [x] 提交：`feat: add local server supervisor`。

## Task 2：Web workspace 与共享客户端契约 ✅ 提交 `f6a242a`

**Files:**
- Modify: `package.json`
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/lib/api-client.ts`
- Create: `web/src/lib/sse-client.ts`
- Create: `web/src/lib/ws-client.ts`
- Create: `web/src/lib/types.ts`
- Test: `web/src/lib/client.test.ts`

- [x] 引入 npm workspace；根脚本增加 `web:dev`、`web:build`、`web:test`，不改变现有 `npm run check` 的 Server 质量门。
- [x] Web 客户端封装 Provider、Models、Sessions、Messages、Abort、Events 和 Supervisor API，不在组件内散落 fetch URL。
- [x] SSE 客户端维护完整 `streamId:sequence` 的 `Last-Event-ID`，处理跨 chunk 帧、reset、error 和重连退避。
- [x] WS 客户端实现 connect、subscribe、unsubscribe、abort、compact、resume，并拒绝未订阅 Session 的事件。
- [x] 将服务端事件 payload 映射为 Web 内部状态类型；未知事件只保留 sequence 和原始 envelope，不执行未知 UI 内容。
- [x] 为 API/事件/WS 客户端写单元测试，使用内存 Response 和 WebSocket fixture，不启动公网服务。
- [x] 运行：`npm run web:test`、`npm run web:build`。
- [x] 提交：`feat: add web workspace protocol clients`。

## Task 3：三栏工作台骨架与连接状态 ✅ 提交 `34b8800`

**Files:**
- Create: `web/src/app/App.tsx`
- Create: `web/src/app/layout.css`
- Create: `web/src/app/state.ts`
- Create: `web/src/components/ServerStatusBar.tsx`
- Create: `web/src/components/SessionSidebar.tsx`
- Create: `web/src/components/ChatPane.tsx`
- Create: `web/src/components/InspectorSidebar.tsx`
- Create: `web/src/components/IconButton.tsx`
- Test: `web/src/app/layout.test.tsx`

- [x] 实现 A 布局：左 Session、中央 Chat、右 Inspector；两侧栏分别由状态控制收起，全部收起时中央区域获得完整宽度。
- [x] ServerStatusBar 显示 Supervisor/Agent Server 的连接状态、端口、延迟、版本和启动/停止/重启按钮；停止状态仍可操作 Supervisor。
- [x] 使用 lucide 或项目选定图标库的图标按钮，所有折叠、重连、Abort、设置按钮提供可访问名称和 tooltip。
- [x] 不把页面写成营销 Landing Page；首屏直接进入工作台，文本层级适合密集扫描。
- [x] 响应式规则：窄屏时右 Inspector 收进抽屉，左 Session 可收进抽屉；不让按钮、状态徽标和中文标签溢出。
- [x] 组件测试覆盖在线、启动中、停止、错误、左右栏独立折叠和全折叠聊天模式。
- [x] 运行：`npm run web:test`、`npm run web:build`。
- [x] 提交：`feat: add collapsible three-column workspace`。

## Task 4：Provider、模型、Session 和工具设置 ✅ 提交 `6887312`

**Files:**
- Create: `web/src/features/providers/ProviderSettings.tsx`
- Create: `web/src/features/providers/provider-form.ts`
- Create: `web/src/features/sessions/SessionList.tsx`
- Create: `web/src/features/sessions/session-settings.ts`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/InspectorSidebar.tsx`
- Test: `web/src/features/settings.test.tsx`

- [x] Provider 表单支持 providerId、名称、协议、Base URL、模型 ID/能力和 API Key；API Key 输入使用密码控件，提交后只显示 credentialConfigured。
- [x] 模型选择只显示 Server 返回的可用模型；Provider 配置变更后刷新模型并保留错误信息。
- [x] Session 列表支持创建、选择、归档、重开和基础搜索；列表状态来自 Server，不复制消息正文。
- [x] Inspector 支持 `off/read-only/all`；切换 `all` 必须选择 cwd 并勾选 Session 级确认，拒绝未确认或越界路径。
- [x] 设置保存后通过 HTTP 更新，成功后重新打开 Session 验证持久化；凭据和 Session JSONL 不进入浏览器 localStorage。
- [x] 测试覆盖表单校验、API Key 脱敏、Provider 错误、工具模式和工作区确认。
- [x] 运行：`npm run web:test`、`npm run web:build`。
- [x] 提交：`feat: add provider session and tool settings`。

## Task 5：流式聊天、Tool Call 与 UI 投影 ✅ 提交 `eaed0c7`

**Files:**
- Create: `web/src/features/chat/chat-state.ts`
- Create: `web/src/features/chat/MessageComposer.tsx`
- Create: `web/src/features/chat/MessageList.tsx`
- Create: `web/src/features/chat/ToolCallItem.tsx`
- Create: `web/src/features/chat/PlanItem.tsx`
- Create: `web/src/features/chat/UiProjection.tsx`
- Modify: `web/src/components/ChatPane.tsx`
- Test: `web/src/features/chat.test.tsx`

- [x] 发送 Prompt 先通过 HTTP 获取 `runId/streamId`，随后用 SSE/WS 接收同一 stream 的事件；输入框支持发送、Abort、Compact 和重试。
- [x] 文本 delta 按 sequence 增量合并，thinking 可折叠，message.completed 后固定最终内容；断线时显示恢复状态而不是清空消息。
- [x] Tool Call 显示名称、参数摘要、运行中、结果、失败和权限拒绝；结果必须经过 Server 脱敏/截断后再展示。
- [x] Plan、Attachment、A2UI v0.9.1 和 TokUI payload 使用受控组件；未知或非法 UI payload 显示安全错误并继续消息流。
- [x] Markdown、链接和附件渲染执行协议过滤，拒绝 `javascript:`、raw HTML 和任意脚本。
- [x] 测试覆盖 delta 合并、乱序/重复 sequence、reset、Tool Call 状态、Abort、Compact、A2UI/TokUI 安全失败。
- [x] 运行：`npm run web:test`、`npm run web:build`。
- [x] 提交：`feat: render streaming chat and tool events`。

## Task 6：Supervisor 集成与浏览器 E2E ✅ 提交 `e12a24a`

**Files:**
- Create: `web/tests/e2e/workspace.spec.ts`
- Create: `scripts/smoke-web.mjs`
- Modify: `web/vite.config.ts`
- Modify: `src/supervisor/app.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `plans/phase-03.md`

- [x] Supervisor 提供 Web 静态资源和 Agent Server 地址发现；开发模式使用 Vite proxy，生产模式使用构建产物。
- [x] Playwright 启动隔离 Supervisor 和本地 Provider fixture，验证 Web 首屏、Server 启停、Provider 设置、新建 Session、真实 Prompt、read 工具、Abort 和重连。
- [x] 浏览器验证左右侧栏独立收起和全折叠聊天模式，至少覆盖桌面宽度和窄屏宽度。
- [x] smoke-Web 失败时清理 Supervisor、Agent Server、端口、锁文件和临时 `PERSON_AGENT_HOME`。
- [x] 运行：`npm run web:build`、`npx playwright test web/tests/e2e/workspace.spec.ts`、`node scripts/smoke-web.mjs`。
- [x] 提交：`test: verify supervisor web workflow`。

## Task 7：Phase 3 质量门与文档

**Files:**
- Modify: `README.md`
- Modify: `docs/product.md`
- Modify: `docs/architecture.md`
- Modify: `AGENTS.md`
- Modify: `plans/phase-03.md`

- [x] 记录 Supervisor 端口、Web 开发/生产命令、三栏交互、工具权限和浏览器验收流程。
- [x] 更新非目标：OAuth、远程访问、Electron、多 Agent、逐次审批仍未完成。
- [x] 运行：`npm run check:pi-imports`、`npm run typecheck`、`npm test`、`npm run build`、`npm run web:test`、`npm run web:build`、`npx playwright test`、`node scripts/smoke-foundation.mjs`、`node scripts/smoke-web.mjs`。
- [x] 检查：`git diff --check`、`git status --short`、敏感文件扫描和残留进程/端口。
- [ ] 创建标签：`phase-3-complete`（待二次验收通过后恢复）。
- [x] 提交：`docs: complete phase 3 web workspace`。

## 二次验收整改（2026-07-22）

首轮验收不通过的 6 项阻塞问题及修复：

1. **Supervisor 未托管 Web/未代理 Agent API** → `createSupervisorApp` 现在返回
   `{ app, nodeWebSocket }`，注册 WS 代理、HTTP/SSE 透明代理（Agent 停止时返回
   502 `AGENT_UNREACHABLE`）、`web/dist` 静态托管与 SPA fallback；`start.ts` 自动解析
   `web/dist`；Vite 分别代理 `/api/supervisor`（4311）、`/api`（4310）与 `/ws`。
2. **核心 Web 功能未接入** → `App.tsx` 完整接线 `chatReducer`/`SseClient`/`WsClient`；
   Abort 携带真实 `streamId`；`sending` 来自 chat 运行状态；新增 `MessageComposer`、
   `MessageList`、`ToolCallItem`、`PlanItem`、`UiProjection` 组件；`ProviderSettings`、
   `SessionSettingsPanel` 挂载到 Inspector；Session 创建显式输入工作目录，支持搜索、
   归档和模型选择。
3. **SSE/WS 协议不兼容** → SSE 客户端注册全部命名事件监听器，依赖 EventSource 自动
   `Last-Event-ID: streamId:sequence` 重连补发，处理 `reset` 事件；WS 客户端按
   `ClientCommandSchema` 发送 `protocolVersion`/`requestId`/`session.*`/`stream.resume`。
4. **浏览器运行时错误与类型漂移** → 移除 `process.cwd()`；`SessionView` 与服务端
   对齐（`model` 为对象、无 `provider` 字段）；服务端新增 `messageEntries`（含角色），
   TUI 与既有测试保持兼容。
5. **E2E 名不副实** → 7 个 Playwright 用例全部通过 `page.goto` 驱动真实页面：首屏、
   页面启动 Server、Provider → Session → 模型 → 真实 Prompt → PI `read` 工具内容、
   Abort、Agent 停止后页面在线、桌面与窄屏布局折叠。
6. **smoke-web 进程清理失败** → 等待子进程退出、Windows `taskkill /T /F` 兜底、
   不再直接 `process.exit(0)`；`process-controller` 健康检查超时/子进程早退时
   终止进程树并标记 error 状态；日志端点增加 API Key 脱敏测试。

# Phase 2：真实模型与 PI 工具闭环实施计划

**状态：已完成（2026-07-22）** | 标签：`phase-2-complete`

最终验收补充：真实 OpenAI-compatible 本地 Provider、PI `read` 工具、Server 重启继续
会话、工作区授权重新确认、思考级别、Runtime 配置失效重建、事件脱敏和 TUI Compact
均已纳入自动化验证。最终质量门为 24 个测试文件、130 个用例。

**目标：** 将持久化 Provider 配置接入真实 PI `AgentSession`，完成真实 LLM 对话、Session 恢复、Abort/Compact 和 PI 内置工具调用。

**架构：** 继续通过 `src/pi-sdk/` 隔离 PI SDK。`ModelService` 从 `ProviderStore` 和 AuthStorage 构造 PI `ModelRuntime`，`SessionRuntime` 使用共享的 PI `SessionManager` 创建真实或 faux AgentSession；Runtime 只发布平台事件，SSE/WS/TUI 保持现有协议。

**技术栈：** Node.js 22.19+、TypeScript 5.9 ESM、PI SDK 0.80.10、Hono、TypeBox、SQLite/WAL、Vitest。

---

## 完成定义

- API Key、Provider、协议、Base URL 和模型可驱动真实 PI 请求；
- Provider/模型/思考级别写入 Session 元数据，重启后恢复；
- 工具模式为 `off`、`read-only`、`all`；`all` 绑定受控工作目录并按 Session 确认一次；
- PI 内置工具 `read/grep/find/ls/write/edit/bash` 按模式启用；
- 文本、思考、工具、turn、错误和状态继续按平台 sequence 发布；
- 未配置凭据、Provider 错误、超时、Abort、Compact 均返回稳定 `ApiError`；
- 本地 Provider fixture、TUI smoke、重启 E2E 和 `npm run check` 全部通过；
- 默认测试不访问外部网络，不读取开发者本机已有凭据。

## 依赖与约束

- 从 `main` 和 `phase-1-complete` 开始，不重做 Phase 1；
- 先阅读 `AGENTS.md`、`docs/architecture.md` 和当前 Git 状态；
- 不在 `src/` 的非 `pi-sdk` 模块 import `@earendil-works/pi-*`；
- 不在 SQLite 保存消息正文，不在普通配置或事件中保存 API Key；
- 每个任务独立提交，任务完成后更新本计划的状态。

---

## Task 1：持久化模型解析与真实 PI ModelRuntime

**Files:**
- Modify: `src/pi-sdk/types.ts`
- Modify: `src/pi-sdk/model-runtime.ts`
- Modify: `src/runtime/model-service.ts`
- Modify: `src/contracts/provider-settings.ts`
- Test: `tests/contract/pi-sdk-adapter.test.ts`
- Test: `tests/integration/provider-settings.test.ts`

- [x] 增加平台模型解析接口 → 提交 `39313dc`
- [x] 保留当前 `listConfiguredModels()` 和环境 fallback
- [x] 运行：`npx vitest run tests/contract/pi-sdk-adapter.test.ts tests/integration/provider-settings.test.ts` ✅
- [x] 提交：`feat: resolve persistent providers through pi model runtime`。

## Task 2：真实 AgentSession 创建路径

**Files:**
- Modify: `src/pi-sdk/agent-session.ts`
- Modify: `src/pi-sdk/types.ts`
- Modify: `src/runtime/session-runtime.ts`
- Modify: `src/runtime/prompt-service.ts`
- Test: `tests/integration/prompt-events.test.ts`
- Test: `tests/integration/session-lifecycle.test.ts`

- [x] 把当前 faux 专用创建函数拆成 `createPiAgentSession(options)` 和保留的 `createPiFauxAgentSession(options)`。→ 提交 `6bd1a79`
- [x] 真实创建函数接收已解析的 PI Model、`ModelRuntime`、共享 `PiSessionHandle`、`cwd`、工具名称和资源加载器，调用 `createAgentSession()`。
- [x] 真实路径从 `session-manager-registry.ts` 复用已有 `SessionManager`。
- [x] 事件映射补齐真实 PI 的 assistant text/thinking、tool start/update/end、turn end 和 abort 结束状态。
- [x] `SessionRuntime.create()` 根据运行配置选择真实或 faux 路径，平台层不得感知 PI AgentSession 类型。
- [x] 写回归测试：真实 fixture Prompt 完成后 `SessionService.getView()` 立即看到历史消息；重启后继续 Prompt 使用同一个 Session ID 和模型引用。
- [x] 运行：`npx vitest run tests/integration/prompt-events.test.ts tests/integration/session-lifecycle.test.ts` ✅
- [x] 提交：`feat: create real pi agent sessions`。

## Task 3：Session 运行配置与工具权限 ✅ 提交 `020c242`

**Files:**
- Create: `src/contracts/session-settings.ts`
- Create: `src/runtime/tool-policy.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/session-index.ts`
- Modify: `src/runtime/session-service.ts`
- Modify: `src/server/routes/sessions.ts`
- Test: `tests/integration/session-settings.test.ts`

- [x] 定义 `ToolMode = "off" | "read-only" | "all"`，以及 `SessionRuntimeSettings`：`model`、`thinkingLevel`、`toolMode`、`cwd`、`workspaceConfirmed`。
- [x] SQLite 增加版本迁移，保存工具模式、cwd、模型和确认状态；消息正文仍禁止进入数据库。
- [x] `tool-policy.ts` 实现：路径规范化、工作目录存在/访问检查、工具模式到 PI 工具名称的映射。
- [x] `all` 模式只有在创建/更新请求明确传入 `workspaceConfirmed: true` 时才允许；cwd 必须位于用户明确选择的工作区，不能接受 `..` 越界路径。
- [x] Session 创建和更新 API 返回脱敏的运行配置；不返回 API Key，不把确认凭据写入 JSONL。
- [x] 测试覆盖默认 `read-only`、越界 cwd、未知 tool mode、未确认 `all`、重启后配置恢复和归档 Session 不可执行。
- [x] 运行：`npx vitest run tests/integration/session-settings.test.ts`。
- [x] 提交：`feat: persist session tool and workspace policy`。

## Task 4：把 PI 内置工具接入真实 Session

**Files:**
- Modify: `src/pi-sdk/agent-session.ts`
- Modify: `src/runtime/session-runtime.ts`
- Modify: `src/contracts/events.ts`
- Modify: `src/runtime/event-mapper.ts`
- Test: `tests/integration/builtin-tools.test.ts`
- Test: `tests/contract/events.test.ts`

- [x] 将 `tool-policy.ts` 返回的工具名传给 `createAgentSession({ tools, cwd })`；不得手工复制 PI 工具实现。
- [x] `off` 传 `noTools: "all"`；`read-only` 传 `tools: ["read", "grep", "find", "ls"]`；`all` 传完整七项工具。
- [x] 为工具事件增加经过限制和脱敏的参数增量与结果摘要，最终结果限制为 2,000 字符。
- [x] 统一工具执行失败、权限拒绝、Abort 中断和正常完成的事件 payload，保证旧 TUI/SSE/WS 客户端仍能解析。
- [x] 使用临时工作区 fixture 验证 read/grep/find/ls；验证 write/edit/bash 只在 `all + confirmed` 时可见。
- [x] 运行：`npx vitest run tests/integration/builtin-tools.test.ts tests/contract/events.test.ts`。
- [x] 提交：`feat: enable pi builtin tools by session policy`。

## Task 5：真实 Provider 错误、Abort 与 Compact

**Files:**
- Create: `src/runtime/provider-errors.ts`
- Modify: `src/runtime/session-runtime.ts`
- Modify: `src/runtime/prompt-service.ts`
- Modify: `src/contracts/api-error.ts`
- Test: `tests/integration/real-runtime-errors.test.ts`
- Test: `tests/integration/abort.test.ts`

- [x] 将 Provider 4xx、5xx、超时、限流、认证失败和无模型统一映射为稳定错误码，`retryable` 只对超时、限流和明确的临时 5xx 为 true。
- [x] Prompt 失败时发布一条安全 `error` 事件并完成当前 stream；不得把 URL、Authorization、API Key 或原始请求体放入 message/details。
- [x] Abort 继续绑定提交时的 `streamId`，真实 AgentSession settle 前禁止同一 Session 启动第二个 Prompt。
- [x] Compact 成功和失败均通过 WS 控制结果返回；Compact 期间 Prompt 被拒绝并给出可重试错误。
- [x] 使用确定性错误夹具覆盖 401、429、500、超时和连接失败；真实请求由本地 HTTP Provider E2E 覆盖。
- [x] 运行：`npx vitest run tests/integration/real-runtime-errors.test.ts tests/integration/abort.test.ts`。
- [x] 提交：`fix: normalize real provider runtime errors`。

## Task 6：TUI 真实模型和工具 smoke

**Files:**
- Modify: `src/tui/app.ts`
- Modify: `src/tui/api-client.ts`
- Modify: `src/tui/render-event.ts`
- Modify: `scripts/smoke-foundation.mjs`
- Test: `tests/integration/tui-real-runtime.test.ts`
- Modify: `README.md`
- Modify: `plans/phase-02.md`

- [x] TUI 在创建/更新 Session 时显示 Provider、模型、tool mode、workspace 和确认状态。
- [x] TUI 使用真实 Server API 发送 Prompt、显示工具状态、Abort、Compact 和重连恢复；未知新事件只前进 sequence 不执行内容。
- [x] `real-provider-tools.test.ts` 完成配置 Provider -> 创建 Session -> 真实 Prompt -> PI read 工具 -> Server 重启 -> 继续对话；基础 smoke 独立验证生产进程启停。
- [x] 手动验收说明真实 OpenAI-compatible 或 Anthropic-style endpoint 的配置步骤，但默认命令不请求公网。
- [x] 运行：`npx vitest run tests/integration/tui-real-runtime.test.ts`、`node scripts/smoke-foundation.mjs`、`npm run check`。
- [x] 提交：`test: verify real provider tui workflow`。

## Task 7：Phase 2 质量门与文档

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `AGENTS.md`
- Modify: `plans/phase-02.md`

- [x] 记录真实 Provider 生产组合已完成、faux fixture 的定位、工具权限语义和测试命令。
- [x] 更新当前分支、提交哈希、真实测试数量和已知限制；不得声称已完成 OAuth、沙盒或逐次审批。
- [x] 运行：`npm run check:pi-imports`、`npm run typecheck`、`npm test`、`npm run build`、`node scripts/smoke-foundation.mjs`。
- [x] 检查：`git diff --check`、`git status --short`、敏感文件扫描。
- [x] 创建标签：`phase-2-complete`。
- [x] 提交：`docs: complete phase 2 real runtime`。

# Phase 1：Runtime、Session 和 TUI 垂直闭环

## 实施状态

**已完成（2026-07-21）**

标签：`phase-1-complete`

| 任务 | 状态 | 提交 |
|---|---|---|
| P1-01 Provider 和凭据设置 | 已完成 | `1f78ad2` |
| Git ignore 边界修复 | 已完成 | `5701bf6` |
| P1-02 Session 生命周期 | 已完成 | `6eada4b` |
| P1-03 Prompt、Abort 和事件归一化 | 已完成 | `c6635cc` |
| P1-04 Replay Store 和 SSE | 已完成 | `a587d91` |
| P1-05 WebSocket 订阅和控制 | 已完成 | `fd917e8` |
| P1-06 TUI 协议客户端 | 已完成 | `56af238` |
| P1-07 A2UI 投影和 Action 验证 | 已完成 | `740340a` |
| P1-08 TokUI Web 投影 Spike | 已完成 | `740340a` |
| P1-09 重启恢复端到端验证 | 已完成 | `9f6e5fc` |
| Phase 1 验收缺口修复 | 已完成 | `2a71636` |

最近一次完整验证（提交 `2a71636`）：18 个测试文件、96 个测试用例通过；
`node scripts/smoke-foundation.mjs` 通过，独立 CLI Server 双进程重启验证通过。

已完成所有基础设施目标：Server 启动自动组装数据库 + 全部 Service、SSE 可恢复流、
WebSocket 订阅控制、TUI 客户端（不 import PI SDK）、A2UI 投影 + Action 校验、
TokUI 安全投影、重启恢复 E2E。`startForegroundServer()` 不再只有健康检查；
生产启动即可获得全部 API 路由。`SessionRuntime.create()` 当前仍为 faux 专用路径，
但与 `SessionService` 共享同一个 PI SessionManager；持久化 Provider 到真实 Prompt 的
组合留待后续 Phase 完成。

## 目标

完成一个真实可用的基础闭环：用户配置 Provider，创建 PI Session，通过 TUI 与
Server 对话，接收可恢复的流式事件，Abort 运行，并在 Server 重启后继续会话。

## 前置条件

- Phase 0 已完成并打 `phase-0-complete` 标签；
- `npm run check` 通过；
- PI SDK Adapter 兼容测试通过；
- Server 只监听 loopback。

## 完成定义

- 自定义 Base URL、Provider、协议、模型和 API Key 可持久化；
- API Key 不进入普通配置、日志或 Session；
- Session 可以创建、列出、打开和继续；
- 文本、思考和工具事件可以通过 SSE 按序发送；
- 断线客户端可以按序号补发事件；
- WS 支持 Session 订阅、Abort、Compact 和 Resume；
- TUI 通过 Server 完成全部操作；
- A2UI 和 TokUI 投影不会修改 Runtime 事件；
- Server 重启恢复集成测试通过。

## 任务顺序

### P1-01：Provider 和凭据设置

**创建文件**

- `src/contracts/provider-settings.ts`
- `src/config/provider-store.ts`
- `src/runtime/model-service.ts`
- `src/server/routes/providers.ts`
- `src/server/routes/models.ts`
- `tests/integration/provider-settings.test.ts`

**工作内容**

- 定义 providerId、protocol、baseUrl、modelId、capabilities 和 headers；
- API Key 交给 PI AuthStorage，普通配置只保存 credential reference；
- 实现 GET/PUT Provider 设置和模型列表；
- 对 Base URL、协议名、重复 Provider 和模型能力做校验；
- 日志和错误对象统一脱敏；
- 环境变量仅在没有持久化配置时作为开发 fallback。

**验证**

```powershell
npx vitest run tests/integration/provider-settings.test.ts
```

预期：配置重开可读，API Key 不出现在响应、日志夹具和 provider JSON 中。

**提交**：`feat: add persistent provider settings`

### P1-02：Session 生命周期

**创建文件**

- `src/runtime/session-service.ts`
- `src/runtime/session-runtime.ts`
- `src/runtime/session-events.ts`
- `src/server/routes/sessions.ts`
- `tests/integration/session-lifecycle.test.ts`

**工作内容**

- 用稳定 Session ID 映射 PI JSONL 文件；
- 实现 create、list、open、archive 和 continue；
- 每个活动 Session 只有一个权威 Runtime；
- Server 停止时释放 PI Session 和订阅；
- 重启后按 SQLite 索引重新定位 JSONL；
- 使用 faux provider 覆盖创建和继续路径。

**验证**

```powershell
npx vitest run tests/integration/session-lifecycle.test.ts
```

预期：重启模拟后 Session ID 不变，历史消息和模型引用正确恢复。

**提交**：`feat: add persistent session lifecycle`

### P1-03：Prompt、Abort 和事件归一化

**创建文件**

- `src/runtime/prompt-service.ts`
- `src/runtime/event-mapper.ts`
- `src/runtime/execution-registry.ts`
- `src/server/routes/messages.ts`
- `tests/integration/prompt-events.test.ts`
- `tests/integration/abort.test.ts`

**工作内容**

- HTTP POST 提交 Prompt 并返回 run/stream 身份；
- 将 PI message/tool/turn 事件映射成平台 Envelope；
- 每个 stream 严格分配递增序号；
- Abort 绑定提交时的 streamId，拒绝中断新流的陈旧请求；
- 返回 accepted、already-stopped 或 rejected；
- 覆盖工具执行中 Abort 和重复 Abort。

**验证**

```powershell
npx vitest run tests/integration/prompt-events.test.ts tests/integration/abort.test.ts
```

预期：事件顺序稳定，陈旧 Abort 不影响后续运行。

**提交**：`feat: stream normalized agent events`

### P1-04：Replay Store 和 SSE

**创建文件**

- `src/runtime/event-replay-store.ts`
- `src/server/sse/session-events.ts`
- `src/server/routes/events.ts`
- `tests/integration/sse-replay.test.ts`

**工作内容**

- 先写 replay store，再向客户端广播；
- 支持 `Last-Event-ID` 和 `sinceSeq`；
- 定义缓存上限、截断和 reset 语义；
- 流结束后保留有限事件供短期重连；
- 慢客户端不能阻塞 PI provider stream；
- 客户端取消订阅时释放资源。

**验证**

```powershell
npx vitest run tests/integration/sse-replay.test.ts
```

预期：断线重连只收到缺失事件；缓存截断时收到明确 reset。

**提交**：`feat: add resumable SSE streams`

### P1-05：WebSocket 订阅和控制

**创建文件**

- `src/server/ws/protocol.ts`
- `src/server/ws/client-registry.ts`
- `src/server/ws/session-handler.ts`
- `tests/integration/ws-session.test.ts`

**工作内容**

- 客户端显式 subscribe/unsubscribe Session；
- WS 消息按 TypeBox Schema 校验；
- 支持 Abort、Compact 和 Resume；
- 非订阅客户端不能接收 Session 事件；
- 同一事件序列化一次后广播；
- 连接关闭时移除全部订阅。

**验证**

```powershell
npx vitest run tests/integration/ws-session.test.ts
```

预期：订阅隔离、控制结果和重连补发通过。

**提交**：`feat: add websocket session control`

### P1-06：TUI 协议客户端

**创建文件**

- `src/tui/api-client.ts`
- `src/tui/event-client.ts`
- `src/tui/app.ts`
- `src/tui/render-event.ts`
- `src/cli/chat-command.ts`
- `tests/unit/tui-render-event.test.ts`
- `tests/integration/tui-smoke.test.ts`

**工作内容**

- 显示 Server online/degraded/stopped；
- 列出和创建 Session；
- 选择 Provider/模型；
- 发送 Prompt，显示 text/thinking/tool/turn/error；
- 支持 Abort 和恢复连接；
- 收到 A2UI 时显示摘要，忽略未知 UI payload 但保留事件序号；
- 禁止 import PI SDK。

**验证**

```powershell
npx vitest run tests/unit/tui-render-event.test.ts tests/integration/tui-smoke.test.ts
npm run cli -- chat
```

预期：faux provider 下可以完成一次对话、Abort 和 Session 重开。

**提交**：`feat: add server-backed TUI client`

### P1-07：A2UI 投影和 Action 验证

**创建文件**

- `src/contracts/ui-message.ts`
- `src/ui-projection/a2ui/catalog.ts`
- `src/ui-projection/a2ui/project.ts`
- `src/ui-projection/a2ui/action.ts`
- `tests/contract/a2ui-projection.test.ts`

**工作内容**

- 固定 A2UI v0.9.1 和本地 Catalog ID；
- 投影 Text、Card、Tool Call、Plan 和 Attachment；
- 禁止远程 Catalog；
- 校验 Action 的 Session、Surface、组件和参数；
- 渲染错误转成平台 `ui.error`；
- 不让 A2UI payload 进入 PI Session 上下文，除非显式投影成文本摘要。

**验证**

```powershell
npx vitest run tests/contract/a2ui-projection.test.ts
```

预期：合法 Surface 和 Action 通过，未知 Catalog/组件/Action 被拒绝。

**提交**：`feat: add A2UI projection boundary`

### P1-08：TokUI Web 投影 Spike

**创建文件**

- `src/ui-projection/tokui/project.ts`
- `src/ui-projection/tokui/policy.ts`
- `tests/contract/tokui-projection.test.ts`
- `examples/tokui-spike/index.html`

**工作内容**

- 从平台事件生成 Tool Call、Plan 和 Status DSL；
- 只允许组件白名单；
- 禁用 sandbox、原始 HTML 和任意 Handler；
- 对 DSL 长度和嵌套深度设上限；
- 示例页通过静态事件夹具调用 `startStream/feed/endStream`；
- Spike 不引入正式 Web 应用和路由系统。

**验证**

```powershell
npx vitest run tests/contract/tokui-projection.test.ts
```

预期：安全 DSL 可生成，危险组件和未注册 Handler 被拒绝。

**提交**：`feat: validate TokUI web projection`

### P1-09：重启恢复端到端验证

**创建文件**

- `tests/e2e/server-restart.test.ts`
- `scripts/smoke-foundation.mjs`

**修改文件**

- `README.md`
- `docs/product.md`
- `docs/architecture.md`
- `plans/phase-01.md`

**工作内容**

- 使用隔离 `PERSON_AGENT_HOME`；
- 启动 Server、配置 faux Provider、创建 Session 并发消息；
- 断开客户端并停止 Server；
- 重启 Server，打开原 Session 并继续；
- 验证事件序号、消息历史、模型引用和凭据隔离；
- 运行完整检查并创建 `phase-1-complete` 标签。

**验证**

```powershell
npm run check
node scripts/smoke-foundation.mjs
git status --short
```

预期：完整闭环通过，工作区干净，没有运行数据进入 Git。

**提交**：`docs: complete phase 1 runtime foundation`

## 风险控制

- 真实 Provider E2E 不进入默认测试，默认使用 faux provider；
- A2UI 和 TokUI 失败只能影响对应内容块，不能中断 Session；
- SSE 与 WS 共享 replay store，禁止各自维护事件序号；
- TUI 出现问题不能绕过 Server 直接调用 PI SDK；
- Phase 1 不加入记忆、多 Agent、Coding Agent 专用工具或完整 Web UI。

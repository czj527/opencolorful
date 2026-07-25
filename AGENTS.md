# person-Agent Agent 协作指南

本文是自动化开发 Agent 在本仓库工作的首要入口，适用于整个 `person-Agent/`
目录。开始修改前必须同时阅读：

1. `README.md`；
2. `docs/product.md`；
3. `docs/architecture.md`；
4. 当前阶段计划，例如 `plans/phase-02.md`；
5. `git status --short` 和最近提交。

三个参考仓库 `<local-workspace>\pi`、`<local-workspace>\oh-my-pi`、
`<local-workspace>\openhanako` 只能用于研究，不属于本仓库，不要把它们加入本仓库的
Git 历史。

## 当前开发状态

- Phase 0 已完成（`phase-0-complete`）；
- Phase 1 已完成（`phase-1-complete`）；
- Phase 2 已完成（`phase-2-complete`），当前在 `main` 分支；
- Phase 2 最终验收修复提交：`333fa0a`；
- 生产 Server 自动装配全部 Service（数据库、Provider、Session、Prompt、Replay、WS）；
- `SessionRuntime.create()` 支持 faux（测试）和真实模型（生产）两条路径；
- 工具权限三级：`off` / `read-only` / `all`（需 cwd 确认）；
- Provider 错误自动映射为稳定 `ApiError`，自动脱敏 URL 和凭据；
- 真实 Provider + PI read 工具 + Server 重启 E2E 已完成；
- Session 设置包含工具模式、工作目录、确认状态和思考级别；
- Phase 3 已完成（`phase-3-complete`），当前在 `phase-3-supervisor-web` 分支；
- Phase 4 已完成——设置中心、偏好持久化、可调侧栏、Focus 模式、日志诊断、流式优化；
- Phase 5 已完成并通过最终验收（2026-07-25）：多 Agent 身份证（UUID 服务端生成）、会话可选绑定 Agent（含重启恢复）、Agent 管理设置页、亮/暗主题、控制栏下移、工具卡片时间线稳定；质量门与 Playwright 17/17 通过；5b 补充轮已完成——人设注入、历史卡片重建、显示开关、一体化输入框、Agent 跟随会话、主题修复（2026-07-25 验收全绿）；
- Phase 6 已完成并通过最终验收（2026-07-25）：Token 用量全链路（事件 → SQLite v5 → 统计 API → 上下文圆环/用量行/用量统计页，不计金额）、对话时间线导航、Web 会话命令系统（`/help` `/compact` `/new` `/abort` `/clear`）、compact 服务端补齐（事件广播/懒重建/409 SESSION_BUSY）、开发流程文档 [docs/development.md](docs/development.md)；质量门与 Playwright 23/23 通过；
- `.gitignore` 误伤 `src/runtime/` 的修复已完成：`5701bf6`；
- P1-02 Session 生命周期已完成：`6eada4b`；
- P1-03 Prompt、Abort 和事件归一化已完成：`c6635cc`；
- P1-04 Replay Store 和 SSE 已完成：`a587d91`；
- P1-05 WebSocket 订阅和控制已完成：`fd917e8`；
- P1-06 TUI 协议客户端已完成：`56af238`；
- P1-07 A2UI 投影 + P1-08 TokUI Web 投影已完成：`740340a`；
- P1-09 重启恢复 E2E 和文档已完成：`9f6e5fc`；
- Phase 1 验收缺口修复已完成：`2a71636`；
- A2UI v0.9.1 官方 Envelope 对齐已完成：`5562743`；
- Phase 3 Supervisor 与 Web UI 已完成；后续 Phase 尚未排期。

截至 Phase 2 最终验收，最近一次完整验证为 24 个测试文件、130 个测试用例通过。该数字只是
交接快照；接手后必须重新运行验证，不得直接复述为当前结果。

## 当前实现边界

已经具备：

- TypeScript ESM、Vitest、构建和 PI import 边界检查；
- `~/.person-agent` 路径约定和 `PERSON_AGENT_HOME` 开发覆盖；
- SQLite/WAL Session 元数据索引；
- Provider、Base URL、协议、模型能力和 Header 的持久化配置；
- API Key 通过 PI `ModelRuntime`/AuthStorage 写入 `auth/auth.json`，不会写入
  `providers.json` 或 API 响应；
- 环境变量只在没有持久化 Provider 时作为 PI 原生开发 fallback；
- PI JSONL Session 的创建、打开、继续、列表和归档；
- 真实 PI `AgentSession` + faux provider 的 Prompt、流式事件和 Abort 测试闭环；
- 平台事件 Envelope、严格 sequence、陈旧 Abort 拒绝；
- Provider、Models、Sessions、Messages、Abort 和 Events（SSE）路由模块；
- EventReplayStore 有界缓存（1000 事件/stream、100 streams）、可恢复 SSE
  （`streamId:sequence` Last-Event-ID）；
- WebSocket 订阅/取消订阅、Abort/Compact/Resume 控制、ClientRegistry；
- TUI 协议客户端（readline + fetch + ANSI），支持跨网络 chunk 的 SSE 解析和断线续传，
  不 import PI SDK；
- A2UI v0.9.1 官方 `createSurface`/`updateComponents` Envelope 投影
  （Text/Card/ToolCall/Plan/Attachment/Status）和官方 Action Envelope 校验；
- TokUI `@jboltai/tokui@0.1.8` Web 投影策略（组件白名单、禁止 raw HTML/脚本、
  精确命名 Handler）；
- 生产 Server Service 组合根（自动装配数据库 + 全部 Service）；
- 生产组合根重启恢复 E2E 测试通过（18 测试文件、94 用例）。

尚未具备：

- OAuth、沙盒和逐次工具审批；
- 私人助理、Coding Agent Profile、记忆、多 Agent、插件和完整 Web UI 交互扩展；
- Electron、LAN/远程访问和云端同步。

faux runtime 只用于确定性测试；生产组合根根据 Session 模型引用创建真实 PI
`ModelRuntime` 和 `AgentSession`。

## 架构硬约束

### PI SDK 边界

- 只有 `src/pi-sdk/` 可以 import `@earendil-works/pi-*`；
- 其他模块只消费 Adapter 暴露的平台接口；
- 禁止 import PI 的 `dist/*`、`src/*` 或其他私有深路径；
- 修改 Adapter 后必须运行 `node scripts/verify-pi-sdk-imports.mjs` 和兼容测试；
- 不复制 PI 的 Provider、Agent Loop、SessionManager 或工具协议实现。

### Server-first

- Runtime 由 Server 持有，TUI/Web 只能通过 HTTP、SSE 和必要的 WebSocket 访问；
- HTTP 用于配置、查询、Prompt、Abort 等请求/响应操作；
- SSE 是默认单向流式事件通道；
- WebSocket 只承担 Session 订阅与控制，以及未来确实需要双向长连接的能力；
- TUI 不得直接 import PI SDK，也不得绕过 Server 修改 Session。

### 数据所有权

- PI JSONL 是消息正文和分支历史的唯一事实来源；
- SQLite 只保存 Session 元数据、索引和平台状态，不保存消息正文；
- Provider 普通配置写入 `config/providers.json`；
- API Key/OAuth 凭据只写 AuthStorage；
- 路径必须来自 `src/config/paths.ts`，禁止调用方自行拼接用户数据目录；
- 不把文件路径作为 Session 身份，跨模块使用稳定 Session ID。

### 事件协议

- 所有跨进程数据先定义 Schema/平台类型，再由实现消费；
- `PlatformEventEnvelope` 的 `protocolVersion` 当前固定为 `1`；
- 同一 `streamId` 的 sequence 从 1 严格递增；
- P1-04 起事件必须先写 Replay Store，再广播给 SSE/WS；
- SSE 与 WS 必须共享 Replay Store，不能各自生成 sequence；
- UI 投影只能消费平台事件，不能反向修改 Runtime 事件。

### 安全

- 不记录、回传或写入普通配置任何 API Key、Authorization、Cookie 等敏感值；
- 错误响应使用稳定 `ApiError`，不要把原始 Provider 请求或凭据拼入 message/details；
- 默认只监听 `127.0.0.1`；在认证完成前不得开放 LAN/远程访问；
- A2UI 只允许本地固定 Catalog；TokUI 只允许白名单组件和命名 Handler；
- 禁止原始 HTML、脚本、`javascript:` URL 和模型生成的任意可执行 Widget。

## 开发流程

开发流程的权威文档是 [docs/development.md](docs/development.md)，核心约定摘要：

- **主 Agent** 负责需求澄清、计划、任务拆分、文件归属划定、子 Agent 协调、
  diff 审查、独立运行质量门、验收、提交与计划回写；
- **子 Agent** 负责并行探索（只读）与归属范围内的实现和针对性测试；
- 子 Agent 报告**不作为验收证据**，主 Agent 必须独立复核 diff 并重跑验证；
- 并行必须同时满足：无共享文件、无共享契约/迁移、无前后依赖；
  有冲突时主 Agent 先实现共享 infra 再并行派发；
- 关键边界先 RED：Provider/Auth、Session 恢复、事件序号/Replay、Abort 竞态、
  WS 权限、A2UI/TokUI 安全、凭据脱敏、用量落库幂等、跨进程输入校验；
- 质量红线（strict 三件套、验证逐条读退出码、Playwright 在 `web/` 执行、
  SSE 白名单同步等）见 development.md 第四节，违反即返工；
- 每任务独立提交并回写 `plans/phase-xx.md`；Phase 验收通过后才更新主文档、
  打标签并请求合并 `main`；
- 每次只实现当前 Phase 任务，不提前加入未排期能力。

除非用户明确要求，不为普通任务引入额外 worktree、复杂流程文档或重复计划。

## 编码规范

- Node.js `>=22.19.0`、TypeScript 5.9、ESM；
- 源码相对 import 使用 `.js` 后缀；
- 保持 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 可通过；
- 跨进程输入使用 TypeBox 或明确解析器，不能用未经校验的类型断言代替验证；
- 平台接口不要暴露 PI SDK 私有类型；
- 优先复用现有 Service、Store、Adapter 和路由注册模式，不创建平行实现；
- 业务逻辑放 Runtime/Service，Hono 路由只处理解析、调用和状态码；
- 错误信息默认中文且不包含敏感输入；代码标识符使用英文；
- 手工编辑使用 `apply_patch`，不使用脚本批量覆写人工维护文件；
- 不修改或回退与当前任务无关的用户改动；
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令。

## 测试与验证

常用命令：

```powershell
npm install
npm run check
node scripts/verify-pi-sdk-imports.mjs
npx vitest run tests/integration/provider-settings.test.ts
npx vitest run tests/integration/session-lifecycle.test.ts
npx vitest run tests/integration/prompt-events.test.ts tests/integration/abort.test.ts
```

`npm run check` 依次执行：PI import 边界、类型检查、全部测试和生产构建。

在 PowerShell 中不要用分号把关键验证与后续成功命令串起来，例如不要使用
`npm run check; git status` 判断整体成功，因为后一个命令可能掩盖前一个退出码。关键
验证命令应单独执行并读取退出码。

需要真实运行数据时使用隔离目录：

```powershell
$env:PERSON_AGENT_HOME = "$PWD\.person-agent"
npm run cli -- server start --foreground
```

提交前额外检查：

```powershell
git diff --check
git status --short
git ls-files | Select-String -Pattern '\.env|\.sqlite|sessions|\.log'
```

默认测试不得请求真实 Provider 网络，不得依赖开发者本机已有 API Key。使用 PI faux
provider 和临时 `PERSON_AGENT_HOME`，并在测试结束后关闭数据库、Runtime 和订阅。

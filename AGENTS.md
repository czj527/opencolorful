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
- 下一项任务是按 `plans/phase-03.md` 实施 Supervisor 和 Web UI。

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
- 私人助理、Coding Agent Profile、记忆、多 Agent、插件和完整 Web UI；
- Supervisor、Electron、LAN/远程访问和云端同步。

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

本项目刻意采用轻量流程，避免复杂 Skill 仪式和不可控 Token 消耗。

1. 确认当前分支和工作区；当前 Phase 2 已在 `main` 完成，开始 Phase 3 时按计划创建
   独立功能分支，不要嵌套 worktree。
2. 阅读当前任务的范围、完成定义和验证命令，先指出会阻塞实现的计划错误。
3. 关键边界先写最小失败测试并确认 RED：Provider/Auth、Session 恢复、事件序号、
   Replay、Abort 竞态、WS 权限、A2UI/TokUI 安全。
4. 普通路由胶水、CLI 文案和简单映射不强制完整 TDD，但必须有相关验证并通过
   TypeScript 严格检查。
5. 每次只实现当前 Phase 任务，不提前加入 Profile、记忆或多 Agent。
6. 先跑任务指定测试，再单独运行 `npm run check`。
7. 每个任务独立提交，提交信息使用计划中给出的标题。
8. 更新当前 `plans/phase-xx.md` 的状态、真实提交和已知偏差。
9. Phase 全部完成后才更新主文档、创建完成标签并请求合并到 `main`。

除非用户明确要求，不启动并行子 Agent。不要为普通任务引入额外 worktree、复杂流程
文档或重复计划。

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

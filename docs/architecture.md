# person-Agent 架构说明

## 架构状态

Phase 0、1、2 已于 2026-07-22 完成。Phase 3 已完成：Supervisor 进程管理（Agent Server 生命周期控制、Web 静态资源托管、HTTP/SSE/WS 透明代理、健康检查 PID 验证、串行化 start、进程树清理）、React Web 工作台（三栏布局、per-stream 事件游标、安全 Markdown 渲染、A2UI/TokUI 白名单投影）、真实 Provider 驱动的 10 个 Playwright 浏览器用例（首屏、表单配置、工具调用、Abort、重启恢复、桌面与窄屏布局）。
[基础设施设计](superpowers/specs/2026-07-21-agent-platform-foundation-design.md)。

## 技术栈

| 项目 | 选择 |
|---|---|
| Runtime | Node.js 22.19+ |
| 语言 | TypeScript 5.9，ESM |
| 包管理 | npm，依赖精确锁定 |
| Agent SDK | `@earendil-works/pi-*` 0.80.10 |
| HTTP | Hono + `@hono/node-server` |
| WebSocket | `@hono/node-ws` / `ws` |
| Schema | TypeBox |
| 元数据 | better-sqlite3，WAL |
| Session 正文 | PI SessionManager JSONL |
| 测试 | Vitest |
| TUI | `@earendil-works/pi-tui` 0.80.10，通过 Server API |
| Web UI | React + Vite；A2UI + TokUI 白名单渲染适配 |

依赖版本必须固定，PI SDK 升级先通过 Adapter 兼容测试，再修改业务代码。

## 初始目录结构

```text
person-Agent/
├── src/
│   ├── cli/               CLI 入口和 Server 生命周期命令
│   ├── config/            数据目录、环境 fallback、配置读取
│   ├── contracts/         HTTP、事件、命令和 UI Schema
│   ├── pi-sdk/            唯一 PI SDK import 边界
│   ├── runtime/           Agent Session 生命周期和事件映射
│   ├── server/            Hono 路由、SSE、WebSocket
│   ├── storage/           SQLite 元数据和 PI Session 定位
│   ├── supervisor/        Agent Server 进程管理和 Web 托管
│   ├── tui/               Server 协议客户端
│   └── ui-projection/     A2UI/TokUI 投影
├── web/                   React Web 工作台（npm workspace）
│   ├── src/
│   │   ├── app/           三栏布局、状态管理
│   │   ├── components/    通用 UI 组件
│   │   ├── features/      Provider/Session/Chat 功能模块
│   │   └── lib/           API/SSE/WS 客户端
│   └── tests/e2e/         Playwright 浏览器测试
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── smoke/
│   └── unit/
├── scripts/             架构边界和质量检查脚本
├── docs/
└── plans/
```

Web UI 已作为 `web/` npm workspace 管理，Server 与 Web 分别构建、测试和由 Supervisor 托管。

## 运行时数据目录

默认数据目录：

```text
~/.person-agent/
├── config/
│   ├── providers.json
│   └── preferences.json
├── auth/
│   └── auth.json
├── sessions/
│   └── <pi-jsonl-files>
├── metadata.sqlite
├── logs/
├── runtime/
│   ├── server.json
│   └── server.lock
└── cache/
```

开发环境可以通过 `PERSON_AGENT_HOME` 指向隔离目录。生产配置不得依赖该变量
才能正常使用。

Phase 0 已实现 `server.json` 的原子更新和 `server.lock` 单实例保护。后台进程在
Windows 上使用隐藏窗口启动，标准输出和错误输出进入 `logs/server.log`。

## 模块边界

### contracts

所有跨模块和跨进程数据都先定义 Schema，再由 TypeScript 类型消费。包含：

- `PlatformEventEnvelope`；
- Session command；
- Provider/model setting；
- Server health/status；
- A2UI/TokUI payload；
- API error。

### pi-sdk

唯一直接依赖 PI SDK 的模块。对外暴露平台稳定接口，不暴露 SDK 私有类型。负责
版本验证、Session 创建、模型注册、工具适配和事件归一化。

`scripts/verify-pi-sdk-imports.mjs` 会扫描 `src/`；适配层以外出现
`@earendil-works/pi-*` import 时，质量检查直接失败。Phase 0 的兼容探针覆盖
PI 0.80.10 内存 Session、内存凭据、faux provider 和工具工厂。

### runtime

以 Session ID 为入口管理 PI Agent Session。运行态与传输层分离，事件只发布到
内部 Event Bus。Phase 2 新增 `ToolPolicy`（工具权限解析）和 `ProviderErrors`
（Provider 错误映射与脱敏）。

### storage

SQLite 只存 Session 元数据、流索引和平台状态。消息正文继续由 PI JSONL 管理，
避免双写和上下文分支不一致。

### server

负责认证边界、输入校验、HTTP/SSE/WS 投影和客户端订阅，不实现 Agent 业务逻辑。

### tui

通过 HTTP/SSE/WS 调用 Server。TUI 不直接依赖 `src/pi-sdk` 或 PI npm 包。

### ui-projection

从结构化平台事件生成 A2UI 或 TokUI 输出。它不能反向修改 Runtime 状态；用户
Action 必须作为命令回到 Server。

## 平台事件封装

```ts
interface PlatformEventEnvelope<T = unknown> {
  protocolVersion: 1;
  eventId: string;
  sessionId: string | null;
  streamId: string | null;
  sequence: number;
  timestamp: string;
  type: string;
  payload: T;
}
```

约束：

- `eventId` 全局唯一；
- 同一 `streamId` 内 `sequence` 从 1 严格递增；
- 持久化事件可以重放；
- 事件先写入 replay store，再发送给客户端；
- 客户端使用最后确认序号恢复；
- 不把文件路径当作 Session 身份。

## API 边界

第一阶段最小路由：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/health` | Server 健康和版本 |
| GET | `/api/server/status` | 生命周期和能力 |
| GET/PUT | `/api/settings/providers` | Provider 配置 |
| GET | `/api/models` | 可用模型 |
| GET/POST | `/api/sessions` | 列表和创建 |
| GET/DELETE | `/api/sessions/:id` | 读取、归档或删除 |
| POST | `/api/sessions/:id/messages` | 发送 Prompt |
| POST | `/api/sessions/:id/abort` | 中断当前运行 |
| POST | `/api/sessions/:id/compact` | 压缩当前会话上下文 |
| GET | `/api/sessions/:id/events` | SSE 订阅和补发 |
| GET | `/ws` | WS Session 订阅与控制 |

Phase 2 已实现表中除 `/api/server/status` 外的路由；Phase 3 由 Supervisor 提供 Web
控制 API、静态托管和 Agent API/WS 代理。

错误统一使用：

```ts
interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

## UI 协议

- 普通文本：结构化 message event + Markdown；
- 标准交互 UI：A2UI v0.9.1；
- Web 高表现力状态：TokUI；
- GenUI 自治 Widget：当前禁用；
- TUI：结构化摘要，不解析 TokUI。

`ui.message` 的格式标记位于 Envelope 的 `payload` 中，不向通用 Envelope 增加
UI 专用字段：

```ts
type UiMessagePayload =
  | { format: "a2ui"; message: Record<string, unknown> }
  | { format: "tokui"; chunk: string };
```

A2UI Catalog 在本地随应用发布并固定版本。Agent 不允许指定任意远程 Catalog。

## 安全

- API Key 只进入 AuthStorage，不写普通配置和 Session；
- 日志统一脱敏；
- Provider 错误、工具增量和工具最终结果统一脱敏并限制长度；
- 完整工具权限的确认绑定到具体工作目录，目录变化必须重新确认；
- 所有 API 输入按 Schema 校验；
- A2UI Action 必须由 Server 重新校验；
- TokUI 仅开放白名单组件和命名 Handler；
- 默认拒绝原始 HTML、脚本和 `javascript:` URL；
- Server 默认只监听 loopback；
- LAN 和远程访问在后续阶段加入认证后再开放。

## 测试策略

必须自动化测试：

- PI Adapter 兼容；
- Provider 配置和凭据隔离；
- Session 重启恢复；
- Event sequence 和 replay；
- Abort 竞态；
- WS 订阅权限；
- A2UI Catalog/Action 校验；
- TokUI 投影安全。

低风险 CLI 文案和简单映射不强制先写失败测试，但必须通过类型检查、相关单测和
smoke test。

## Git 和提交策略

- `main` 保持可构建、可测试；
- 每个任务形成独立提交；
- Phase 完成后打本地标签，例如 `phase-0-complete`；
- 不提交 API Key、Session 数据、日志、数据库和构建产物；
- 重大协议变化新增 ADR 并在提交信息中引用。

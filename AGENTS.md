# OpenColorful Agent 协作指南

本文是自动化开发 Agent 在本仓库工作的首要入口，适用于整个 `opencolorful/` 目录。开始修改前必须先读懂本项目定位与架构（见下方文档导航）。

## 核心理念与定位

**OpenColorful = 承载 agent 完整一生的本地优先平台基础设施。**

核心理念：**给每个 agent 完整的一生**。agent 不只是"有用的工具"——它有自我（人格、性格、记忆、想法）、有成长、有生活、有社交。它的职业形态（coding 工程师 / 设计师 / 文档撰写员 / 陪伴朋友）由创建者通过插件特化决定，**平台不预设 agent 是什么**。我们关注 agent 的"自我"，而非市面 agent 追求的"有用性"。

三层架构：

- **Agent 生命基础设施层**（核心，部分完成）：agent 的"自我"——身份与底色（✅ Phase 8）/ 记忆(dreaming) / 成长(curator) / 生活(案头+笺) / 社交(多 agent) / 运行时(✅ Phase 0-7)
- **形态特化层**（待建，关键难点）：插件化的完整交互基础设施（coding IDE+终端+浏览器 / design 画布 / 文档编辑器 / 陪伴对话）。**注意：形态特化 ≠ 技能包**，是完整交互基础设施（专用 UI+工具链+工作区）
- **生态流转层**（待建）：角色卡一生档案 / 人格模板市场 / 技能包市场 / Bridge 多平台

完整定位与路线见 [docs/positioning-and-roadmap.md](docs/positioning-and-roadmap.md)；基础设施边界与选型见 [docs/infrastructure-decisions.md](docs/infrastructure-decisions.md)。

## 文档导航

| 文档 | 作用 | 何时读 |
|---|---|---|
| `docs/positioning-and-roadmap.md` | **核心理念与开发路线权威**（定位/三层架构/Phase 8-14/差异化） | 必读，理解项目是什么 |
| `docs/infrastructure-decisions.md` | **基础设施边界与开发决策**（记忆命名体系/沙箱定位/subagent 特化/日志 Electron 时机/流程评估） | 必读，理解边界与选型 |
| `docs/logging-architecture.md` | **Phase 11 日志架构草案**（三通道、trace、持久化、扩展接入、隐私与保留） | 评审或开发日志/插件/subagent 时读 |
| `docs/architecture.md` | 架构说明（Phase 0-3 平台层技术栈/模块边界/事件协议） | 改平台层时读 |
| `docs/development.md` | 开发流程规范（角色/并行/质量门）——部分已被本文件简化 | 改流程前读 |
| `docs/product.md` | 产品说明（旧定位，部分已过时，以 positioning-and-roadmap.md 为准） | 参考历史 |
| `plans/phase-00~07.md` | 已完成阶段计划 | 了解历史 |
| `plans/phase-08.md` | Phase 8 实施计划、范围校正与验收记录 | 接续 Agent 模型工作时读 |
| `plans/phase-09.md` | Phase 9 实施计划与验收记录 | 了解历史 |
| `plans/phase-10.md` | Phase 10 实施计划、评审修复与验收记录 | 了解历史 |
| `plans/phase-10.5.md` | Phase 10.5 记忆 Agent 与后台整理计划 | 进入记忆 Agent 阶段时读 |
| `plans/phase-11.md` | Phase 11 完整日志系统计划草案 | 评审或实现统一可观测性时读 |

## 参考仓库

`<local-workspace>\references\` 下有 8 个参考仓库（`pi` / `oh-my-pi` / `openhanako` / `openclaw` / `hermes-agent` / `lobe-chat` / `codex` / `opencode`），**只用于研究，不属于本仓库，不要加入本仓库 Git 历史**。各项目定位与借鉴点见 positioning-and-roadmap.md 第六章。

## 当前开发状态

- **Phase 0-7 已完成并通过验收（2026-07-25）**：平台层运行时底座——Server / Session / Provider / Supervisor / Web UI / Agent 身份证+人设注入 / Token 用量 / UI 重构。质量门全过，Playwright 23/23。
- **Phase 8 已完成（2026-07-28）**：Agent 模型去枚举化（identity v2，无 `type`）、底色与运行设置分离、旧数据迁移、底色模板、Windows 工作目录选择、独立 Agent 创建/编辑页和新会话创建页。模板只用于初始化，不是 Agent 的持久化依赖。
- **Phase 9 已完成（2026-07-28 验收，已合并）**：应用层 PathGuard 沙箱系统（能力声明 + 执行边界 + 审计日志），多轮安全审查后合入 `main`。
- **Phase 10 已完成（2026-08-01 验收，`phase-10-complete`）**：记忆系统底座——openhanako 四段 Markdown 传送带、PI 分支感知 rolling summary、事件索引（FTS5 + CJK n-gram）、`search_memory` 主动回想（RecallEpisode + Agent SSE）、intent-only 记忆工具、封存队列、dirty 恢复与 `/memory` 只读页。
- **当前定位已重新明确（2026-07-27）**：从"全能私人助理平台"修正为"承载 agent 完整一生的平台基础设施"。
- **下一阶段（Phase 10.5）**：记忆 Agent 与后台整理——sealed batch 消化、retention/activation 强度、proposal + MemoryPolicy 审批、每日空闲/每周复核调度、时间线强度 UI。穿插完善结构化日志框架。
- Phase 8 已移除 `type: work|coding|assistant` 硬枚举；yuan 模板、capabilities、skills、插件与梦境仍属于后续阶段，不在本阶段提前固化。

接手后必须重新运行验证（`npm run check`），不得直接复述历史测试数字。

## 当前实现边界

已经具备（平台层）：

- TypeScript ESM、Vitest、构建和 PI import 边界检查；
- `~/.opencolorful` 路径约定和 `OPENCOLORFUL_HOME` 开发覆盖；
- SQLite/WAL Session 元数据索引；
- Provider、Base URL、协议、模型能力和 Header 的持久化配置；
- API Key 通过 PI `ModelRuntime`/AuthStorage 写入 `auth/auth.json`，不写入普通配置；
- PI JSONL Session 的创建、打开、继续、列表和归档；
- 平台事件 Envelope、严格 sequence、Replay Store、SSE/WS；
- TUI 协议客户端（不 import PI SDK）；
- A2UI v0.9.1 + TokUI Web 投影（白名单安全）；
- 生产 Server Service 组合根（自动装配）；
- Supervisor 进程管理 + React Web 工作台；
- 多 Agent 身份证 + 底色人设注入 + Token 用量全链路。
- Phase 8 Agent 基础模型：`identity.json`、`base-color.json`、`settings.json`、底色模板 API、创建/编辑路由与新会话创建页。

下一阶段核心目标（原"非目标"，现已转为核心）：

- 沙箱机制（能力声明 + 执行边界 + 应用层 PathGuard）；
- 记忆系统（案头/笺/今日记/往事/识见/手艺/梦境）；
- 结构化日志框架 + 关键行为埋点。

暂不做（等自我层稳定）：Electron 桌面端、形态特化层（coding/design 专用交互基础设施）、技能自创（手艺高阶）、性格自我演变（风险极高，yuan 作稳定锚点不漂移）。

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
- 事件必须先写 Replay Store，再广播给 SSE/WS；
- SSE 与 WS 必须共享 Replay Store，不能各自生成 sequence；
- UI 投影只能消费平台事件，不能反向修改 Runtime 事件。

### 安全

- 不记录、回传或写入普通配置任何 API Key、Authorization、Cookie 等敏感值；
- 错误响应使用稳定 `ApiError`，不要把原始 Provider 请求或凭据拼入 message/details；
- 默认只监听 `127.0.0.1`；在认证完成前不得开放 LAN/远程访问；
- A2UI 只允许本地固定 Catalog；TokUI 只允许白名单组件和命名 Handler；
- 禁止原始 HTML、脚本、`javascript:` URL 和模型生成的任意可执行 Widget。

## 开发流程

开发流程权威是 [docs/development.md](docs/development.md)，本节是 2026-07-27 简化版。

### 角色定位（保留）

- **主 Agent**：需求澄清、计划、任务拆分、文件归属划定、子 Agent 协调、diff 审查、独立运行质量门、验收、提交与计划回写；
- **子 Agent**：并行探索（只读）与归属范围内的实现、针对性测试、更新文档；
- **铁律**：子 Agent 报告**不作为验收证据**，主 Agent 必须独立复核 diff 并重跑质量门；子 Agent 不得扩大范围、自行 git 提交或宣称通过。

### 任务生命周期（简化为 5 步，去掉 RED）

1. **计划**：主 Agent 编写/更新 `plans/phase-xx.md`；
2. **实现**：子 Agent 按归属实现 + 针对性测试（普通胶水代码不强制 TDD，但必须通过类型检查与相关测试）；
3. **验证**：主 Agent 独立复核 diff + 重跑质量门；
4. **提交**：每任务独立提交，提交信息用计划标题；
5. **回写**：更新 `plans/phase-xx.md` 状态、验证证据、已知偏差。

> 关键边界（Provider/Auth、Session 恢复、事件序号/Replay、Abort 竞态、凭据脱敏、用量幂等等）仍需充分测试覆盖，但**不强制先写失败测试（RED）**。质量由类型检查 + 集成测试 + 质量门保证。

### 并行规则（保留）

同时满足才允许并行：无共享文件、无共享契约/迁移、无前后依赖。有冲突时主 Agent 先实现共享 infra 再并行派发。

### 质量门（验收时必须全部单独通过）

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test
```

**browser-use 实际交互验收**（每个 Phase 完成后，主 Agent 执行）：
1. `npm run web:build && npm run cli -- supervisor start`
2. 使用 browser-use（`control-browser` skill）打开 `http://127.0.0.1:4311`
3. 按 Phase 验收标准逐项操作验证用户可感知的新功能
4. 截图留存关键验收证据
5. `npm run cli -- supervisor stop`

> browser-use 侧重新功能交互验收，可作为 Playwright E2E 的补充或替代。详见 `docs/development.md`。

### 质量红线（违反即返工）

- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 必须全过；
- 相对 import 带 `.js` 后缀；跨进程输入用 TypeBox 或显式解析器校验；
- 事件先写 Replay Store 再广播；同 streamId sequence 从 1 严格递增；
- 验证命令逐条单独执行并读取退出码，**禁止 PowerShell 分号串联**关键验证；
- Playwright 必须在 `web/` 目录执行；
- 新增 SSE 事件类型必须同步 `web/src/lib/sse-client.ts` 的 `KNOWN_EVENT_TYPES`；
- 不记录/回传/落库任何 API Key、Authorization、Cookie；
- 手工编辑用 apply_patch；不用 `git reset --hard`、`git checkout --` 等破坏性命令；
- 默认测试不得请求真实 Provider 网络，用 PI faux provider + 临时 `OPENCOLORFUL_HOME`。

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
$env:OPENCOLORFUL_HOME = "$PWD\.opencolorful"
npm run cli -- server start --foreground
```

提交前额外检查：

```powershell
git diff --check
git status --short
git ls-files | Select-String -Pattern '\.env|\.sqlite|sessions|\.log'
```

默认测试不得请求真实 Provider 网络，不得依赖开发者本机已有 API Key。使用 PI faux
provider 和临时 `OPENCOLORFUL_HOME`，并在测试结束后关闭数据库、Runtime 和订阅。

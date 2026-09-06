# OpenColorful Agent 协作指南

本文是自动化开发 Agent 在本仓库工作的首要入口，适用于整个 `opencolorful/` 目录。开始修改前必须先读懂本项目定位与架构（见下方文档导航）。

## 核心理念与定位

**OpenColorful = 本地优先的个人助理 Agent 平台与个人效率工作台。**

近期目标是先做出一个真正好用、可控、可持续的个人助理 Agent，再让用户和 Agent 在同一个工作台里管理项目、资料、任务与日程。“给 Agent 完整的一生”是远期愿景，不是当前产品承诺。

当前产品结构：

- **个人助理层**（近期）：人格、记忆、文件、工具、Skill、Plugin、提醒和有限主动性；
- **人与 Agent 工作台**（下一阶段）：用户项目、任务、资料、日程与 Agent 会话、工作空间的一体化；
- **生态与自扩展层**（远期）：Bridge、角色卡、技能生态以及受约束的 Cordis 化能力演进。

完整定位与路线见 [docs/positioning-and-roadmap.md](docs/positioning-and-roadmap.md)；基础设施边界与选型见 [docs/infrastructure-decisions.md](docs/infrastructure-decisions.md)。

## 文档导航

| 文档 | 作用 | 何时读 |
|---|---|---|
| `docs/positioning-and-roadmap.md` | **产品定位与开发路线权威**（个人助理/工作台/远期自扩展） | 必读，理解项目是什么 |
| `docs/project-status.md` | **当前状态权威**（当前基线、活动阶段、优先级、状态更新规则） | 每次接手任务时读 |
| `docs/document-governance.md` | **文档治理与变更影响权威**（单人+AI agent 护栏定位、事实归属、CI 门禁） | 每次新增功能或跨边界修改时读 |
| `docs/infrastructure-decisions.md` | **基础设施边界与开发决策**（记忆命名体系/沙箱定位/subagent 特化/Electron 定位） | 必读，理解边界与选型 |
| `plans/g1-repo-convergence.md` | G1 仓库收敛与 Desktop 优先计划 | 涉及前端归属、文档结构、编号时读 |
| `plans/g2-desktop-release.md` | G2 桌面发布分发与版本更新计划 | 涉及桌面打包、发布流程、版本更新时读 |
| `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md` | P1 切片 1 规格（个人助理首个垂直切片） | 做 P1 功能时必读 |
| `docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md` | P1 切片 1.5 规格（可用性攻坚：会话中心 IA/设置页极简/SSE 性能） | 做 P1 功能时必读 |
| `docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md` | P1 切片 1.75 规格（记忆激活：行为契约/工具引导/后台复盘/闭环实证） | 做记忆功能时必读 |
| `plans/desktop-parity.md` | 桌面全能力对齐（D 波次，已并入 P1） | 做桌面功能时读 |
| `docs/ci-cd.md` | GitHub Actions、分支保护和发布流程 | 修改 CI/CD 或准备发布时读 |
| `plans/README.md` | 计划生命周期、状态词和完成标准 | 创建或接续计划时读 |
| `docs/logging-architecture.md` | 日志架构权威（三通道、trace、持久化、隐私与保留） | 开发或评审日志/插件/subagent 时读 |
| `docs/memory-architecture.md` | 记忆架构权威 | 开发或评审记忆功能时读 |
| `docs/architecture.md` | 架构说明（平台层技术栈/模块边界/事件协议） | 改平台层时读 |
| `docs/architecture-map/` | 可交互架构地图；manifest 维护语义，zh-CN 词典维护中文解释，project-board 维护开发看板，生成器维护文件覆盖率与导入证据 | 理解模块关系、查看当前状态、跳转源码或新增模块时读 |
| `docs/development.md` | 开发流程规范——部分已被本文件简化 | 改流程前读 |
| `docs/product.md` | 产品说明（旧定位，已过时，以 roadmap 为准） | 参考历史 |
| `plans/phase-00~14.md` | 平台底座阶段计划，**已全部归档** | 仅查历史证据时读 |

## 参考仓库

`<local-workspace>\references\` 下有 9 个参考仓库（`pi` / `oh-my-pi` / `openhanako` / `openclaw` / `hermes-agent` / `lobe-chat` / `codex` / `opencode` / `deepseek-harness`），**只用于研究，不属于本仓库，不要加入本仓库 Git 历史**。各项目定位与借鉴点见 positioning-and-roadmap.md 第六章。

## 当前开发状态

当前状态权威是 `docs/project-status.md`（每次接手必读），本节只保留入口摘要：

- 平台底座 Phase 0-14 已全部完成并归档（实施证据在 `plans/phase-00~14.md`，不作为当前待办）；
- G0 仓库治理已完成（2026-08-26）：CI 三 job、分支保护、文档治理生效；
- **当前主线**：P1 个人助理切片 1（`docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`，桌面补齐 D 波次并入 P1 轨道）；G1 仓库收敛已完成（`plans/g1-repo-convergence.md`）；
- 当前定位（2026-08-22 明确，2026-08-26 收敛）：本地优先的个人助理 Agent 平台与个人效率工作台；`desktop/` 为唯一产品前端，`web/` 保留为浏览器运维、测试与协议验收客户端。

接手后必须重新运行验证（`npm run check`），不得直接复述历史测试数字。文档治理检查可单独运行 `npm run check:docs`。

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

当前主线目标：

- Product P1 切片 1：可用的桌面个人助理（onboarding、对话主干补齐、人格可见、记忆日用、错误恢复，规格见文档导航）；
- 随后：P1 切片 2（提醒与有限主动性）、P2 个人效率工作台。

暂不做：Agent 完整生活、无约束的自我成长、自动编写并直接安装插件、广泛的多 Agent 团队/DAG 编排和未经治理的远程 Bridge；这些属于 P3/R1 之后的路线。

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

开发流程权威是 [docs/development.md](docs/development.md)（含任务 Brief 合同、子 Agent 报告合同、产品决策四态标注、风险驱动验证矩阵），本节保留摘要。

### 角色定位（保留）

- **主 Agent**：需求澄清、计划、任务拆分、文件归属划定、子 Agent 协调、diff 审查、独立运行质量门、验收、提交与计划回写；派发子 Agent 必须使用任务 Brief 合同（development.md §4）；
- **子 Agent**：并行探索（只读）与归属范围内的实现、针对性测试、更新文档；返回必须使用报告合同（development.md §5）；
- **铁律**：子 Agent 报告**不作为验收证据**，主 Agent 必须独立复核 diff 并重跑质量门；子 Agent 不得扩大范围、自行 git 提交或宣称通过。

### 任务生命周期（5 步）

1. **计划**：主 Agent 编写/更新 `plans/` 下对应计划；
2. **实现**：子 Agent 按 Brief 实现 + 针对性测试（普通胶水代码不强制 TDD，但必须通过类型检查与相关测试）；
3. **验证**：主 Agent 独立复核 diff + 重跑质量门；
4. **提交**：每任务独立提交，提交信息用计划标题；
5. **回写**：更新计划状态、验证证据、已知偏差。

> 关键边界（Provider/Auth、Session 恢复、事件序号/Replay、Abort 竞态、凭据脱敏、用量幂等等）仍需充分测试覆盖，但**不强制先写失败测试（RED）**。质量由类型检查 + 集成测试 + 质量门保证。验证组合按风险选择（development.md §7）。

### 并行规则（摘要）

完整 7 项并行条件与 `serial_reason` 强制记录见 development.md §2。摘要：无共享文件、无共享契约/迁移、无前后依赖、接口已稳定、涉及决策已批准；**并行是默认目标，串行必须写明理由**。有冲突时主 Agent 先实现共享 infra 再并行派发。

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

# 测试资产矩阵（Test Asset Matrix）

**建立：2026-08-31（P1 波次 A · 任务 A1）**
**权威计划：** [`plans/p1-quality-model-usage.en.md`](../../plans/p1-quality-model-usage.en.md)
**配套约定：** [`docs/testing/desktop-test-conventions.md`](desktop-test-conventions.md)
**维护规则：** 新增/修改任何用户可见功能或后端行为时必须同步本矩阵（行增删、状态、证据路径）。状态不允许用"CI 全绿"隐式替代；每行的状态指该行**目标自动化层**的最近一次真实执行结果。

## 一、自动化层定义

| 层 | 名称 | 工具与位置 | 现状 |
|---|---|---|---|
| L0 | 资产层 | 本矩阵 + 证据清单 | 本文档 |
| L1 | 单元 | `tests/unit/**`、`web/src/**/*.test.*`（vitest） | 在跑（根 2129 例 + web 426 例） |
| L2 | 契约/适配 | `tests/contract/**`、`tests/contracts/**`、`verify-pi-sdk-imports`、`verify-plugin-imports` | 在跑 |
| L3 | 服务端集成 | `tests/integration/**`、`tests/e2e/**`（faux provider + 临时 `OPENCOLORFUL_HOME`） | 在跑 |
| L4 | Web 运维面 | `web/tests/e2e/`（Playwright，workers=1，串行） | 在跑（59 例） |
| L5 | Desktop Mock | `desktop/` 渲染层回归（无后端，MockDataSource 注入状态；`npm run test --workspace=@opencolorful/desktop`） | **在跑（A2，2026-09-01：11 文件 24 例）** |
| L6 | Desktop Electron 真链 | Playwright `_electron` + 隔离 home/user-data-dir + 本地 stub Provider（`npx playwright test --config desktop/tests/e2e/playwright.config.ts`） | **在跑（A3，2026-09-01：@smoke 真链合并链 1 例；CI Desktop smoke job 已接入）** |
| L7 | 韧性/发布 | 故障注入、安装包冒烟、更新链路 | 待建（A3/A9 部分） |

## 二、状态词

- `PASS`：该行目标层有在跑的自动化证据或最近一次真实执行为通过（注明日期）。
- `FAIL`：最近一次执行为失败，根因已定位或已立项。
- `BLOCKED-ENV`：环境阻塞（如缺凭据），注明解除条件。
- `SKIP`：从未执行或 UI 无此入口，必须注明原因；"待建"层一律视为 SKIP，不视为缺陷。

## 三、模块码

| 码 | 模块 | 码 | 模块 |
|---|---|---|---|
| ONB | Onboarding 首启引导 | MEM | Memory 记忆页与查询 |
| AGENT | Agent 身份与档案 | TICK | MemoryTicker / 滚动摘要 |
| WS | Workspace 工作区 | MAGENT | Memory Agent / 后台复盘 |
| SESS | Session 创建与生命周期 | SUB | Subagent 子代理 |
| CHAT | 首条消息与聊天流 | PLUG | Plugin 插件 |
| SSE | SSE/WS/Replay 事件通道 | SKILL | Skill 技能 |
| ABORT | Abort 中止 | SUPV | Supervisor 进程管理 |
| COMPACT | 会话压缩 | OBS | Observability 日志/观测 |
| PROV | Provider/Auth 凭据 | USAGE | Usage 用量 |
| SET | Settings/preferences 设置 | SEC | Sandbox/审批 |
| REL | 发布/安装/恢复 | SHELL | Desktop 外壳与全局状态 |

## 四、矩阵本体

> 列含义：详细交互链 = 用户入口 → 关键步骤；服务端事实 = API/JSONL/SQLite 真值对照点；既有覆盖 = 当前已存在的自动化证据（文件级）。

### ONB · Onboarding 首启引导

实现事实：onboarding **无后端模块**，首启状态由前端 `desktop/src/use-first-run.ts` 从 `GET /api/agents`（空）与 `GET /api/settings/providers`（无 credentialConfigured）派生；页面 `desktop/src/components/OnboardingPage.tsx`。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| ONB-01 | 干净 home 启动 → 自动进四步引导 → 逐步填写（名字+底色模板 → Provider 预设+API Key → 工作目录 → 权限说明）→ 完成 | `POST /api/agents` 201 三文件落盘；`PUT /api/settings/providers` 凭据只入 AuthStorage | 四步逐步推进，完成后进对话页且助理已选中 | L6 | A3 `smoke.truechain.spec.ts` @smoke 合并链（2026-09-01） | PASS（L6，2026-09-01） | 首启派生依赖两端点，探测失败时放行 ready（不阻塞启动） |
| ONB-02 | 完成引导后重启应用 | `GET /api/agents` 非空 | 不再自动进引导 | L6 | A3 冒烟 Phase 2 重启段（2026-09-01） | PASS（L6，2026-09-01） | — |
| ONB-03 | 引导中点「稍后再说」→ 空态再点「开始引导」 | — | 退出进空态，可重进 | L5/L6 | A2 `onboarding.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01）/SKIP（L6 未执行） | — |
| ONB-04 | 第 1 步空名点下一步；第 2 步错 Key/非法 URL；模板接口失败兜底 | 校验失败不写后端 | 内联中文错误（`role=alert`）；模板失败渲染空白模板不崩 | L5 | A2 `onboarding.mock.test.tsx` ×3（2026-09-01） | PASS（L5，2026-09-01） | Mock 需支持模板接口失败注入（已具备） |
| ONB-05 | 第 3 步点「浏览…」 | `POST /api/directories/pick` | 弹原生目录对话框；取消回退手输 | L6 | L3 `directory-picker.test.ts`（17 例）；A4a `lane-a4a-onboarding`（stub dialog 真链全链，2026-09-02） | PASS（L6，2026-09-02） | 非 Windows 返回 501；无桥时静默 null 回退 |

### AGENT · Agent 身份与档案

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| AGENT-01 | 空态/新建会话对话框「新建助理…」→ 名字+模板+可选默认目录 → 创建 | `POST /api/agents`；`agents/<id>/identity.json`、`base-color.json`、`settings.json` 三文件 | 助理出现在空态 chips/会话对话框下拉 | L6 | L1 `agent-store.test.ts`（21）、L3 `agent-routes.test.ts`（19）；A3 冒烟（2026-09-01） | PASS（L6，2026-09-01） | 默认目录可空（cwd 兜底链路见 SESS-01） |
| AGENT-02 | 空态身份证卡展示名称/编号/底色；点「编号」复制；点卡进档案页 | `GET /api/agents/:id` | 卡片信息正确；剪贴板含编号；进档案页 | L5/L6 | A2 `agent.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01）/SKIP（L6 未执行） | — |
| AGENT-03 | 档案页改名+改描述保存；侧栏 badge/会话头 chip 同步；重启保持 | `PUT /api/agents/:id`（仅 name 可变） | 三处同步；重启后保持 | L6 | L3 `agent-routes.test.ts`；A4a `lane-a4a-agent`（2026-09-02） | PASS（L6，2026-09-02） | 档案页改名不触发 agents 列表刷新（agentsRefresh 仅建/删助理触发），badge/chip 同步依赖重启——已记 A7 打磨 |
| AGENT-04 | 档案页编辑人设（回复风格/人格标签）保存 | `PUT /api/agents/:id/base-color` | 保存成功提示；重进保持 | L6 | L3 `persona-injection.test.ts`（注入侧 5 例）；A4a `lane-a4a-agent`（2026-09-02） | PASS（L6，2026-09-02） | Mock `updateAgentBaseColor` 忽略 innerSetting，L5 不可验全字段 |
| AGENT-05 | 档案页记忆设置（启用整理/后台复盘/每日时间/最小空闲）保存 | `PUT /api/agents/:id/memory/settings`（迟滞阈值排序校验） | 保存生效；重启保持 | L6 | L3 `memory-admin-api.test.ts`（11）；A4a `lane-a4a-agent`（2026-09-02） | PASS（L6，2026-09-02） | 连续快速保存的读改写竞态已在热修修复（2026-09-02） |
| AGENT-06 | 多助理：空态助理 chips 切换归属；记忆页/档案页助理切换 | 各 API 按 agentId 隔离 | 切换后数据为对应助理 | L6 | L3 `memory-isolation.test.ts`（12）；A4a `lane-a4a-agent`（2026-09-02） | PASS（L6，2026-09-02） | Mock 单份档案不支持多助理区分 |

### WS · Workspace 工作区

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| WS-01 | 新建会话对话框填目录 → toolMode=all 且未勾确认 → 提交被拦 | `POST /api/sessions` 不发出 | 对话框内报错，不建会话 | L5/L6 | L3 `session-settings.test.ts`（16）；A2 `workspace.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01）/SKIP（L6 未执行） | — |
| WS-02 | 会话 toolMode=all 且 workspaceConfirmed=false → WorkspaceBanner 出现 → 点「确认工作区」 | `PUT /api/sessions/:id/settings` confirmed=true | 横幅消失；写工具解锁 | L6 | 历史 B4 已修复回归（2026-08-22 手动）；L3 `session-settings.test.ts`；A4a `lane-a4a-workspace`（2026-09-02） | PASS（L6，2026-09-02） | 历史人工回归已由 A4a 自动化固化 |
| WS-03 | 横幅上点「切换为只读」 | `PUT /api/sessions/:id/settings` toolMode=read-only | 横幅消失；chip 变 read-only | L6 | A4a `lane-a4a-workspace`（2026-09-02） | PASS（L6，2026-09-02） | — |
| WS-04 | Composer 工作目录 chip 展示 basename | `GET /api/sessions/:id` cwd | chip 显示目录名 | L5 | 无 | SKIP（L5 未建） | **chip 无 handler（占位展示控件）**，不可点击为已知事实 |
| WS-05 | 沙箱规则查看：`GET /api/sandbox/status`、`/api/sandbox/rules/:agentId` | PathGuard 规则（脱敏） | —（无 UI 入口） | L3 | L1 `path-guard.test.ts`（17）、`sandbox-*.test.ts` 等 6 文件 | PASS（L1/L3） | 无产品 UI，矩阵仅记录 API 面 |

### SESS · Session 创建与生命周期

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SESS-01 | 新建会话（助理无 defaultCwd）→ 发首条消息 | `POST /api/sessions` cwd 三级解析：显式 > agent defaultCwd > per-agent workspace 兜底（`ensureWorkspace` 建目录） | 会话创建成功进对话页 | L3/L6 | L3 `session-agent-binding.test.ts`（14 例，含兜底 3 例，2026-08-31）；A3 冒烟（2026-09-01） | PASS（L3/L6，2026-09-01） | 无 agentId 且无 cwd → 400 INVALID_INPUT（负例已覆盖） |
| SESS-02 | 侧栏新建会话 → 草稿空态（不落库）→ 首条消息后出现 | 首发消息才 `POST /api/sessions`（产品决策 #1） | 草稿态文案「发送首条消息后才会出现在会话列表」 | L5/L6 | A2 `session.mock.test.tsx`（2026-09-01）；A3 冒烟（2026-09-01） | PASS（L5/L6，2026-09-01） | — |
| SESS-03 | 行内重命名（铅笔/双击，Enter 保存 Esc 取消） | `PUT /api/sessions/:id/title` 双写 JSONL+SQLite 索引 | 侧栏与会话头同步 | L3/L5/L6 | L3 `session-rename.test.ts`（5）；A4a `lane-a4a-session`（2026-09-02） | PASS（L3/L6，2026-09-02）/SKIP（L5 未建） | Mock 内存改写与真实双写的一致性已由 L6 验 |
| SESS-04 | 归档（API）→ 归档区折叠展示 → 行内「恢复」 | `DELETE /api/sessions/:id`、`POST /api/sessions/:id/unarchive` | 归档区出现/恢复回活跃列表 | L3/L6 | L3 `session-lifecycle.test.ts`（6）；A4a `lane-a4a-session`（2026-09-02） | PASS（L3/L6，2026-09-02） | **已知限制 #7**：外部变更侧栏不感知，经重启加载验证（无 SSE 失效刷新） |
| SESS-05 | 会话设置 chips（toolMode/thinkingLevel/模型）切换 → reload 后保持 | `PUT /api/sessions/:id/settings`、`/model`（busy→409） | chips 显示与后端一致 | L6 | L3 `session-settings.test.ts`；历史 B2/B3/B5 PASS（人工）；A4a `lane-a4a-session`（2026-09-02） | PASS（L6，2026-09-02） | Mock `updateSessionModel` 空操作、thinkingLevel 恒回 "high"，L5 不可验 |
| SESS-06 | 运行中切模型 → 409 | 服务端 SESSION_BUSY | 中文错误提示不静默 | L3/L6 | L3 `session-settings.test.ts` | PASS（L3）/SKIP（L6 未建） | — |

### CHAT · 首条消息与聊天流

实现事实：草稿会话不落库（产品决策 #1）。`App.tsx` `send()` 链路 = `createThread` → `updateSessionModel` → `updateSessionSettings` → `sendPrompt`；模型/设置下发失败不阻塞首条消息（静默 catch）。历史重建由 `desktop/src/data/projector.ts` `projectHistory` 完成（用户 → 思考 → 工具 → 助手）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| CHAT-01 | 空态输入首条消息 → 创建会话 → 下发模型/运行设置 → 发送 | `POST /api/sessions`（cwd 三级兜底）→ `PUT /api/sessions/:id/model`、`PUT /api/sessions/:id/settings` → `POST /api/sessions/:id/messages`；正文入 JSONL | 对话页出现用户消息并开始流式回复；会话进入侧栏 | L3/L6 | L3 `session-agent-binding.test.ts`（14，2026-08-31）；A3 冒烟（2026-09-01） | PASS（L3/L6，2026-09-01） | 模型/设置下发失败静默（catch 忽略），端到端一致性只能 L6 验 |
| CHAT-02 | 切换会话 → 历史重建 | `GET /api/sessions/:id` messageEntries | 用户/思考/工具/助手按语义顺序渲染 | L1/L3 | L1 `desktop-projector.test.ts`；L3 `prompt-events.test.ts`；A3 冒烟重启段（2026-09-01） | PASS（L1/L3/L6，2026-09-01） | Mock 源直接覆写 items 时索引失效走自愈路径 |
| CHAT-03 | 发送后流式：token 增量推进 → 消息定稿；事件行（思考/工具/文件/计划/子代理/记忆/审批）展开收起 | SSE `GET /api/sessions/:id/events`；Envelope sequence 严格递增；先 Replay 后广播 | 流式光标消失后定稿；事件行可展开详情 | L1/L3 | L1 `desktop-projector.test.ts`；L3 `prompt-events.test.ts`；A3 冒烟 + A2 SSE 回放（2026-09-01） | PASS（L1/L3/L6，2026-09-01）/SKIP（L5 回放底座） | 合批窗口内中间帧不可断言，只能断言 flush 快照 |
| CHAT-04 | 无已配置凭据模型时发送 | `GET /api/models` 全部 credentialConfigured=false，请求不发出 | 中文错误 +「去配置 Provider」入口按钮 | L5 | L3 `provider-settings.test.ts`（API 层）；A2 `chat.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | 已知偏差（切片1 T6）：模型列表未加载完的瞬间有误中窗口；引导完成后模型列表不刷新已在热修修复（2026-09-01） |
| CHAT-05 | IPC 断线时发送 | 无请求发出 | 明确 offline 中文错误，不静默 | L6 | A4b `lane-a4b-chat`（circuit 断开，2026-09-02） | PASS（L6，2026-09-02） | 断线期发送不创建会话、恢复后重连可发送均已验证 |
| CHAT-06 | Provider 错误（错 Key/限流/超时）渲染 | 稳定 `ApiError`；不回传凭据 | `role=alert` 中文错误 + 下一步动作按钮 | L3/L5 | L3 `real-runtime-errors.test.ts`；A4b `lane-a4b-chat`（2026-09-02，三种错误各一行运行错误并收敛） | PASS（L3/L6，2026-09-02）/SKIP（L5 未建） | 模型调用失败曾因 stopReason=error 被吞——已在热修补 turn.failed 终态（2026-09-02） |

### SSE · SSE/WS/Replay 事件通道

实现事实：Desktop 渲染层不直连 HTTP；`IpcDataSource.subscribeChat` 经主进程 `subscribeEvents` 订阅 `GET /api/sessions/:id/events`（ipc-source.ts:362）；`GET /api/agents/:id/events` 服务记忆维护事件（ipc-source.ts:411）。WS `/ws` 仅 Web 运维面使用。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SSE-01 | 事件先写 Replay Store 再广播；同 streamId sequence 从 1 严格递增 | `PlatformEventEnvelope` protocolVersion=1 | —（协议契约） | L1/L3 | L3 `contract/events.test.ts`、`sse-replay.test.ts`；L1 `event-mapper.test.ts` | PASS（L1/L3） | — |
| SSE-02 | 断线重连 replay 不丢事件 | Replay Store 按 after/Last-Event-ID 补发 | 重连后时间线补齐 | L3/L6 | L3 `sse-replay.test.ts` | PASS（L3）/SKIP（L6） | Desktop 断线恢复路径未验 |
| SSE-03 | WS 与 SSE 共享 Replay Store，不各自生成 sequence | `server/ws/session-handler.ts` 消费同一 store | —（协议契约） | L3 | L3 `ws-session.test.ts` | PASS（L3） | — |
| SSE-04 | Desktop 订阅链路：SSE over IPC → projector 合批 → snapshot；切页不中断流 | 订阅存活期间 SSE 持续推进 | 消息连续渲染；`streaming` 布尔窄订阅驱动 App | L1 | L1 `desktop-projector.test.ts` | PASS（L1）/SKIP（L6） | 真链 IPC→SSE 转发只能 L6 验 |

### ABORT · Abort 中止

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| ABORT-01 | 流式中点停止按钮 → abort | `POST /api/sessions/:id/abort` | 退出流式态，可继续输入 | L3/L6 | L3 `abort.test.ts`；A3 冒烟（2026-09-01）；A4b 竞态视角（2026-09-02） | PASS（L3/L6，2026-09-02） | 终态事件 turn.cancelled 未被 projector 处理导致卡死已在热修修复（2026-09-01）；终态信封现由运行时显式发出（2026-09-02） |
| ABORT-02 | Abort 竞态：完成瞬间 abort；abort 后迟到事件不入投影 | ExecutionRegistry 中止语义 | UI 状态一致 | L3 | L3 `abort.test.ts`；A4b `lane-a4b-abort`（迟到事件观察窗 + 立刻重发收养新 stream，2026-09-02） | PASS（L3/L6，2026-09-02） | — |

### COMPACT · 会话压缩

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| COMPACT-01 | Composer 输入 `/compact` → 触发压缩 | `POST /api/sessions/:id/compact`；JSONL 分支归档 | 摘要替换正文后时间线更新 | L3/L5 | L3 `compact-route.test.ts`；A2 `compact.mock.test.tsx`（2026-09-01） | PASS（L3/L5，2026-09-01） | L5 侧仅覆盖草稿会话 `/compact` 拦截文案 |
| COMPACT-02 | 压缩后重启继续对话 | JSONL 分支历史事实源 | 上下文延续 | L3 | L3 `session-lifecycle.test.ts`、`tests/e2e/server-restart.test.ts` 部分 | PASS（L3）/SKIP（L6） | 压缩后 UI 时间线形状仅 L6 端到端 |

### PROV · Provider/Auth 凭据

实现事实：凭据只入 PI AuthStorage，renderer 不回显 Key；`ProvidersSettings` + `SettingsModal` DefaultModelRow 是 Desktop 仅有的两个写入口。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| PROV-01 | 设置→模型与 Provider→新增/编辑 Provider→保存 | `GET/PUT /api/settings/providers`；凭据入 AuthStorage | 列表出现新 Provider；Key 不回显 | L3/L5 | L3 `provider-settings.test.ts`；A4c `lane-a4c-provider-settings`（2026-09-02） | PASS（L3/L6，2026-09-02）/SKIP（L5 未建） | 引导自定义预设的模型显示名残留缺陷已在热修修复（2026-09-02） |
| PROV-02 | 凭据缺失的模型不进入可用列表 | `GET /api/models` credentialConfigured 标记 | 模型选择器不出现该项 | L1/L3 | L3 `provider-settings.test.ts`；A4c 凭据翻转 → chips 菜单一致性（2026-09-02） | PASS（L1/L3/L6，2026-09-02） | — |
| PROV-03 | 错 Key/非法 URL 负例 | 稳定 `ApiError`，不拼敏感输入 | 中文错误 | L3 | L3 `provider-settings.test.ts`、`real-runtime-errors.test.ts`；A4c `lane-a4c-provider-settings`（客户端拦截 + 服务端 400 不泄露秘密，2026-09-02） | PASS（L3/L6，2026-09-02） | — |
| PROV-04 | 设置页切全局默认模型 | `PUT /api/settings/preferences` defaults.model | 新会话草稿缺省采用 | L3/L5 | L3 `settings-routes.test.ts`、`unit/preferences.test.ts`（A0 回归 29/29）；A4c 重启采用 + 失效引用漂移提示（2026-09-02） | PASS（L3/L6，2026-09-02）/SKIP（L5） | 草稿模型解析优先级/内置目录兜底语义待 A6 两档模型策略收口 |

### SET · Settings/preferences 设置

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SET-01 | 设置页四类目全接线（外观/模型与 Provider/对话显示/关于） | — | 无死类目 | L5 | A2 `settings.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |
| SET-02 | 对话显示：事件类型显隐开关即时生效 | local-prefs 持久化 | 时间线即时过滤；重启保持 | L5 | A2 `settings.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |
| SET-03 | 外观：主题三态 + 减少动效 | local-prefs + html data 属性 | 即时切换；重启保持 | L5 | A2 `settings.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |
| SET-04 | 偏好 route→file→reopen 幂等（含 `subagents` 段） | `GET/PUT /api/settings/preferences` | 与后端一致；subagents 不丢 | L3 | L3 `settings-routes.test.ts` + L1 `preferences.test.ts`（A0 RED→GREEN） | PASS（L3） | — |
| SET-05 | 关于页：版本与连接信息 | `GET /api/health` | 显示版本/连接模式 | L5 | A4c `lane-a4c-provider-settings`（版本=主进程桥上报，dev 版本对齐修复；连接信息与 serverUrl 真值一致，2026-09-02） | PASS（L6，2026-09-02） | dev 下 app.getVersion() 曾返回 Electron 运行时版本，已修复（2026-09-02） |

### MEM · Memory 记忆页与查询

实现事实：页面 = compiled 四段（今天/本周/长期/重要事实）+ facts/events 列表 + pinned 管理 + timeline + maintenance 订阅（仅 ipc 模式）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| MEM-01 | 打开记忆页 | `GET /api/agents/:id/memory/compiled|facts|events|pinned|health` | 四段与列表渲染；加载/错误态 | L3/L5 | L3 `memory-admin-api.test.ts`（11）；A2 `memory.mock.test.tsx`（2026-09-01） | PASS（L3/L5，2026-09-01） | — |
| MEM-02 | 关键字搜索（400ms 防抖） | `GET facts/events?q=` | 过滤结果 | L3/L5 | L3 `memory-recall.test.ts`、`memory-stores.test.ts`；A2 `memory.mock.test.tsx`（fixture 注入）；A4d 生产 Mock q 过滤 parity 修复 + 用例（2026-09-02） | PASS（L3/L5，2026-09-02） | Mock 过滤为大小写折叠子串近似（非完整 FTS5 语义），静态 fixture 下无差异 |
| MEM-03 | pinned 新增/删除 | `POST/DELETE /api/agents/:id/memory/pinned` | 列表即时更新 | L3/L5 | L3 `memory-admin-api.test.ts`；A2 `memory.mock.test.tsx`（2026-09-01） | PASS（L3/L5，2026-09-01） | — |
| MEM-04 | 手动 flush（封装+重建索引） | `POST /api/agents/:id/memory/flush` | 完成提示 | L3/L5 | L3 `memory-compile.test.ts`、`memory-stores.test.ts` | PASS（L3）/SKIP（L5） | Desktop 无 flush UI（「立即整理」= deep-dive，MAGENT-01）——A4d 已核实，无 L5 目标面 |
| MEM-05 | maintenance 状态条实时更新 | SSE `GET /api/agents/:id/events` | 运行中/空闲标签切换 | L6 | A4d `lane-a4d-memory`（2026-09-02：SSE wire 级按序 + 维护条实时收敛 + 报告真值对照） | PASS（L6，2026-09-02） | script 模式毫秒级整轮，UI 中间态可能跳变——wire 级证据补足 |
| MEM-06 | 多助理切换数据隔离 | 各 API 按 agentId 隔离 | 数据随助理切换 | L3 | L3 `memory-isolation.test.ts`（12）；A4a `lane-a4a-agent` AGENT-06（记忆页/档案页切换，2026-09-02） | PASS（L3/L6，2026-09-02） | — |

### TICK · MemoryTicker / 滚动摘要

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| TICK-01 | 长会话触发 ticker → rolling summary 更新与注入预算 | utility LLM 调用；预算阈值 | 注入内容受预算约束 | L3 | L3 `memory-ticker.test.ts`、`memory-summary.test.ts` | PASS（L3） | — |
| TICK-02 | ticker/摘要模型来源与角色标注 | selectSecondary("memory") 统一选择；旧字段仅作映射来源 | 次级模型来源/角色在用量与日志可辨 | L3 | L3 `session-settings.test.ts`（真实 selectSecondary 装配断言） | PASS（L3，2026-09-04） | 用量角色标注待 A8 交付 |

### MAGENT · Memory Agent / 后台复盘

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| MAGENT-01 | deep-dive 运行与 run 报告查看 | `POST deep-dive`、`GET memory/runs/:runId` | 报告文本可查 | L3/L5 | L3 `memory-agent.test.ts`、`memory-admin-api.test.ts`；A4d L5 脚本化维护链 + L6 真链（2026-09-02） | PASS（L3/L5/L6，2026-09-02） | — |
| MAGENT-02 | 后台复盘闭环：turn.completed → utility 调用 → journal 意图（actor=background_review）→ 审批 → search_memory 召回 | `reviewEnabled` 设置；schema v13 | 逐步断言中间态（行为级） | L3/L5 | L3 `memory-background-review.test.ts`、`memory-activation.test.ts`（T15 闭环）；档案页开关交互由 A4a AGENT-05 覆盖（2026-09-02） | PASS（L3/L6，2026-09-02） | — |
| MAGENT-03 | deep-dive 回滚 | `POST deep-dive/rollback` | 回滚成功 | L3 | L3 `memory-admin-api.test.ts` | PASS（L3） | — |

### SUB · Subagent 子代理

实现事实：Desktop 侧只读（threads/transcript/messages/artifacts/stream）；`subagent_runs` 保留生命周期与累计 tokens，未入统一 usage API（A8 范围）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SUB-01 | Dock 列 threads → 选 thread → transcript/runs/messages/artifacts | `GET /api/subagents/threads/:id/transcript|messages|artifacts` | 列表/详情/错误态 | L3/L5 | L3 `subagent-spawn-repro.test.ts`、`subagent-migration.test.ts`；L1 `subagents-*`（约 20 文件）；A2 `subagent.mock.test.tsx`（2026-09-01） | PASS（L1/L3/L5，2026-09-01） | — |
| SUB-02 | transcript SSE 实时推进 | `GET /api/subagents/threads/:id/stream` | 详情随流更新 | L1/L6 | L1 `subagents-replay-store.test.ts`；A4e `lane-a4e-subagent`（2026-09-02：真实 spawn tool_calls → dock 列表/详情/运行中/终态 → SSE seq 严格递增 + progress→run→result 顺序） | PASS（L1/L6，2026-09-02） | 真链 spawn 依赖 stub 流式 tool_calls（lane 本地 fixture 已建） |
| SUB-03 | subagents.defaultModel 持久化 | preferences `subagents` 段 | route→file→reopen 保持 | L3 | L1 `preferences.test.ts` + L3 `settings-routes.test.ts`（A0 RED→GREEN） | PASS（L3） | Desktop 设置页无 subagents 模型入口（A7d 补齐） |
| SUB-04 | subagent tokens 进统一用量查询 | `subagent_runs` 累计 tokens 不在 usage API | — | — | 无 | SKIP（A8 缺口，已立项） | A8 交付后补行 |

### PLUG · Plugin 插件

实现事实：Desktop 无插件管理 UI；插件面在 Web 运维客户端与 CLI（`src/cli/commands/plugins.ts`）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| PLUG-01 | 安装/启用/禁用/更新/回滚/卸载全生命周期 | `POST/DELETE /api/plugins/*` 全套路由 | Web 运维面操作成功 | L3/L4 | L3 `plugin-installer/registry/facade` 等；L4 `plugin-lifecycle.spec.ts`、`plugin-smoke.spec.ts` | PASS（L3/L4） | Desktop 无入口（无产品需求前不入矩阵 UI 行） |
| PLUG-02 | 插件密钥配置与脱敏 | `POST/DELETE /api/plugins/:id/secrets` | 不回显明文 | L3 | L3 `plugin-config-secret.test.ts` | PASS（L3） | — |
| PLUG-03 | dev 场景热载（reload/invoke/run-scenario） | `/api/plugins/dev/*` 路由 | 场景执行成功 | L3 | L3 `plugin-dev-host/scenario.test.ts` | PASS（L3） | — |

### SKILL · Skill 技能

实现事实：Desktop 无 Skill UI；同 Plugin，面在 Web 与 CLI。安装含确认令牌审批（`confirmation/:tokenId/approve`）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SKILL-01 | inspect/install → 确认令牌 → approve → 绑定生效 | `POST /api/skills/inspect|install`、`POST confirmation/:tokenId/approve` | Web 面生命周期完成 | L1/L3/L4 | L1 `tests/unit/skills/*`（约 35 文件）；L3 `skills/skill-routes.test.ts`；L4 `skill-lifecycle.spec.ts` | PASS（L1/L3/L4） | — |
| SKILL-02 | 会话 Skill 绑定注入五工具 | `GET/POST /api/sessions/:id/skills` | 会话内工具可用 | L1/L3 | L1 `session-skill-service.test.ts`、`skill-tools.test.ts` | PASS（L1） | — |
| SKILL-03 | 来源信任/linked sources/bundles 管理面 | `/api/skill-sources`、`/api/skills/linked-sources|bundles|:ref/files`、`PUT agents/:id/skills/policy` | —（无 Desktop UI） | L1/L3 | L3 `skills/composition-root.test.ts` 等；L1 `linked-source-registry.test.ts` | PASS（L1/L3） | — |

### SUPV · Supervisor 进程管理

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SUPV-01 | `supervisor start/stop` 拉起/停止 agent server | CLI `src/cli/supervisor-command.ts`；`supervisor/app.ts` | server 就绪、stop 干净退出 | L3 | L3 `supervisor.test.ts`（T11 自动拉起） | PASS（L3） | — |
| SUPV-02 | watchdog 崩溃拉起 | 进程监控 | 自动重启 | L3 | L3 `supervisor-watchdog.test.ts` | PASS（L3） | — |
| SUPV-03 | Desktop 内嵌后端启动与端口回退 | `electron/main.cjs` 动态 import server-dist；EADDRINUSE 随机端口回退 | embedded server online 日志 | L7 | 无自动化（G2 T4 手工验证） | SKIP（A3 CI smoke 落地后补） | 打包 asar 依赖完整性由 `verify:pack` 断言 |

### OBS · Observability 日志/观测

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| OBS-01 | 日志页三 tab（活动/错误/安全审计）+ 健康 badge | `GET /api/observability/activity|audit|errors|health` | 三视图 + 健康 badge 渲染 | L3/L4/L5 | L3 `observability-api/server.test.ts`；L4 `logs.spec.ts`；A2 `observability.mock.test.tsx`（2026-09-01） | PASS（L3/L4/L5，2026-09-01） | — |
| OBS-02 | 活动过滤（category/level/status/搜索）+ 分页 + SSE 实时追加 | `GET activity` 过滤参数、`{channel}/stream` | 过滤生效、新行追加 | L1/L5 | L1 `observability-query.test.ts`；A4f `observability.mock.test.tsx`（2026-09-02：过滤/分页 cursor/实时跟随开关） | PASS（L1/L5，2026-09-02） | 生产 mock queryActivity 忽略 cursor（恒 null）——分页用例经注入源验证客户端链 |
| OBS-03 | retention 预览/执行（与 Audit 同事务 fail-closed） | `POST /api/observability/retention/preview|run` | 删除生效、审计留痕 | L1/L3 | L1 `observability-retention.test.ts`；L3 `observability-server.test.ts` | PASS（L1/L3） | — |
| OBS-04 | 客户端事件回传脱敏 | `POST /api/observability/client-events` | 落库无敏感值 | L3 | L3 `observability-api.test.ts` | PASS（L3） | — |
| OBS-05 | 诊断 tail 与 trace 关联查询 | `GET diagnostic/tail`、`GET traces/:traceId` | 可定位记录 | L3 | L3 `observability-api.test.ts`；A5 Desktop 关联链路（2026-09-02：UI 错误行诊断引用 → 日志页 traceId 预填 → activity/traces 命中，`lane-a5-diagnostics`） | PASS（L3/L6，2026-09-02） | 引用只含 id 与时间戳（脱敏红线）；通道边界 diagnostic/activity/audit 不混用 |

### USAGE · Usage 用量

实现事实：usage 记录主会话成功 `turn.completed`（`(session_id, turn_id)` 幂等）；subagent runs tokens 不在 API；`completeText()` 不返回 usage 元数据（A8 范围）。

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| USAGE-01 | 会话头 UsageBadge：tokens/turns/context% | `GET /api/sessions/:id/usage` | badge 渲染；一轮结束后刷新 | L3/L5 | L3 `usage-api.test.ts`、`usage-recorder.test.ts`；A4f `chat.mock.test.tsx`（2026-09-02：渲染 + streaming 翻转刷新链） | PASS（L3/L5，2026-09-02） | mock 无 usage recorder，第 2 次返回值为脚本化（服务端记账由 L1/L3 覆盖） |
| USAGE-02 | 全局用量摘要 | `GET /api/usage/summary` | Web 运维面展示 | L3/L4 | L3 `usage-api.test.ts`；web `usage-section.test.tsx` | PASS（L3/L4 组件） | Desktop 无全局入口（A8 交付） |
| USAGE-03 | 幂等不重复计数 | `(session_id, turn_id)` 去重 | 重复事件不双计 | L1/L3 | L3 `usage-recorder.test.ts` | PASS（L3） | — |
| USAGE-04 | 非成功终态的部分用量 | — | — | — | 无 | SKIP（A8） | A8 交付后补行 |

### SEC · Sandbox/审批

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SEC-01 | toolMode=all 未确认 fail-safe 降级只读 + 横幅（见 WS-02/03） | `workspaceConfirmed` 服务端 fail-safe | 横幅出现、写工具锁定 | L3 | L3 `session-settings.test.ts`（16） | PASS（L3） | — |
| SEC-02 | PathGuard 路径越权拒绝 | PathGuard 规则 | 工具调用失败 | L1 | L1 `path-guard.test.ts`（17） | PASS（L1） | — |
| SEC-03 | sandbox 状态/规则 API 脱敏 | `GET /api/sandbox/status`、`/api/sandbox/rules/:agentId` | —（无产品 UI，矩阵仅记录 API 面） | L1/L3 | L1 `sandbox-service/policy/preflight/sandbox-contracts` | PASS（L1/L3） | — |
| SEC-04 | 聊天内审批（允许一次/拒绝）→ 工具放行/拒绝 | 审批事件走平台事件协议 | 按钮状态机切换 | L3/L5 | L3 `builtin-tools.test.ts`、`sandbox-tools.test.ts`；A4f `chat.mock.test.tsx`（2026-09-02：approved/denied 两分支回归锚点） | PASS（L3/L5，2026-09-02） | Desktop 审批按钮为本地 state（现行语义锚点）；A2 对齐真实协议后需同步修订 |
| SEC-05 | fail-closed 审计（高风险修改入 Audit） | audit 与删除同事务 | 高风险修改留痕 | L3 | L3 `observability-failclosed.test.ts` | PASS（L3） | — |

### REL · 发布/安装/恢复

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| REL-01 | `desktop:pack` 全链（build→stage→rebuild:native→builder→verify:pack） | staging `file:` 依赖实拷；asar 断言 | 打包产物可安装 | L7 | G2 T4 `verify:pack` 脚本级（PR #39） | PASS（脚本）/SKIP（安装启动实测） | v0.1.1 Release 仍为 Draft（G2 收口项） |
| REL-02 | 应用内更新状态机 | `update:check/download/get-state` IPC + electron-updater | UpdateBanner 下载完成后出现 | L7 | 无自动化 | SKIP（G2 收口项） | 真实更新链路需发布后验证 |
| REL-03 | release workflow 资产断言 | GitHub Actions 发布流程 | 资产完整可下载 | L7 | workflow 配置（PR #37） | PASS（配置）/SKIP（真实发布） | — |
| REL-04 | 安装版首启冒烟（onboarding→对话） | — | 全流程可用 | L7 | 无 | SKIP（A3/A9） | cwd 兜底热修的安装版实测依赖本行 |

### SHELL · Desktop 外壳与全局状态

| ID | 详细交互链 | 服务端事实 | 预期可见结果 | 自动化层 | 既有覆盖 | 状态 | 风险 |
|---|---|---|---|---|---|---|---|
| SHELL-01 | 数据源选择：桥存在→probe→IPC；失败→Mock 回退 + MockBanner | `createDataSource()` probe | Mock 模式显示横幅 | L5 | A2 `shell.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |
| SHELL-02 | 连接状态指示（Titlebar 离线点/身份证卡离线态/chip 状态） | `subscribeConnection` 探活 | 离线标签出现 | L6 | 无 | SKIP（L6 未建） | 探活节律仅真实桥可验 |
| SHELL-03 | 主题/减少动效 data 属性生效 | local-prefs | 样式即时切换 | L5 | A2 `shell.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |
| SHELL-04 | 页面路由与空态守卫（无助理时 memory/profile 不渲染） | — | 空态引导入口 | L5 | 无 | SKIP（L5 未建） | — |
| SHELL-05 | 侧栏折叠 SidebarRail 展开/收起 | — | 状态保持 | L5 | A2 `shell.mock.test.tsx`（2026-09-01） | PASS（L5，2026-09-01） | — |

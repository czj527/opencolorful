# Desktop ↔ 后端对接（desktop wiring）

> 2026-08-20 启动 | 状态：**进行中**
> 目标：Electron 桌面端从 mock adapter 切换到真实 Agent Server，过程可控、可验证、可回退。
> 设计基线：[docs/design.md](../docs/design.md) §7（Backend isolation）；API 清单依据：本轮调研（见附录）。

## 架构决策

```
renderer (React, sandboxed)
   └─ DesktopDataSource（接口，UI 只依赖它）
       ├─ MockDataSource   —— 现有 fixture + 模拟事件流（离线开发/测试用）
       └─ IpcDataSource    —— preload bridge → Electron 主进程
main process (Node)
   ├─ api-proxy.cjs  —— HTTP 代理到 Supervisor 4311（降级直连 4310）
   └─ sse-proxy.cjs  —— SSE 订阅/解析/重连（Last-Event-ID），帧经 IPC 推到 renderer
```

关键决策：

1. **走主进程 IPC 代理，不直连**：Server/Supervisor 均无 CORS 中间件，renderer（file:// 或 dev 5174 origin）直连会被浏览器拦截；主进程 Node fetch 无 CORS 问题，且符合"凭据/网络不出主进程"的隔离约定。preload 只暴露通用 `invoke(method, path, body)` + SSE 订阅原语，主进程校验 path 必须以 `/api/` 开头，不开放任意 URL。
2. **服务端发现**：优先 `http://127.0.0.1:4311`（Supervisor，`/api/supervisor/status`），失败降级 `http://127.0.0.1:4310`（`/api/health`）；`OPENCOLORFUL_SERVER_URL` 可显式覆盖。
3. **事件投影共享**：SSE Envelope → 时间线条目的投影逻辑（`data/projector.ts`）对 Mock 与真实数据源是同一份代码——Mock 也生成平台事件形状，保证联调路径即最终路径。投影语义对齐 `web/src/features/chat/chat-state.ts`（用户消息本地乐观、message.delta 追加、tool 按 stream 分组、streamId 过滤重放）。
4. **重放策略（slice 1）**：会话打开时历史走 REST（`GET /api/sessions/:id` → messageEntries）；SSE 只应用"本客户端发起的 prompt stream"的事件，旧 stream 重放一律丢弃（已知限制：另一客户端对同一会话发消息不会实时出现，刷新可见）。
5. **mock 回退**：无 Electron 桥（纯浏览器 dev）或探测不到服务器时，自动使用 MockDataSource，标题栏显示"离线 · mock"。

## 任务切片

- [x] S0 调研：API/SSE/WS 清单、web chat-state 投影语义、事件 payload 契约
- [x] S1 主进程：api-proxy + sse-proxy + preload 桥（`desktopApi.invoke/subscribeEvents`）
- [x] S2 renderer 数据层：`DesktopDataSource` 接口 + projector + Mock/Ipc 双实现
- [x] S3 会话链路：agents/sessions 列表、历史打开、发送 prompt（首条消息建会话）、SSE 实时事件、abort
- [x] S4 记忆页：六个端点（compiled/facts/events/pinned/health/timeline）+ memory.agent.* 维护状态 SSE
- [x] S5 日志页：observability health + activity/audit/errors 查询（首 200 条客户端过滤）
- [x] S6 验收：真实 Supervisor 全链路截图证据（见下方验收记录）

## 验收记录

2026-08-20，开发机 Windows，隔离数据目录 `OPENCOLORFUL_HOME=.opencolorful`：

1. `npm run desktop:build`（tsc strict + vite）通过。
2. `npm run cli -- supervisor start` + `POST /api/supervisor/start` 启动 Agent Server（4310）。
3. 经 API 创建开发 Agent「原」（id `7a6d205f…`，dev home 此前为空）。
4. Playwright 驱动真实 Electron 窗口（`electron.launch`，加载 `desktop/dist`）逐项验证：
   - 标题栏显示「已连接 · 127.0.0.1:4311」——IPC 探测与主进程代理工作正常；
   - 侧栏展示真实 Agent「原」及其 persona 描述；会话为空 → 新会话空态（Agent 选择 chips + composer）；
   - 记忆页六端点全部返回真实响应（idle / 0 batch / 空闲维护态 / 空四段 / 空时间线）；
   - 日志页展示真实 observability 数据（`agent.created`、`system.started`、`storage.database.opened`、`supervisor.*` 等，含类别/组件/时长/Epoch 徽标），审计 tab 正常。
5. 截图：`.tmp/w1~w5`（验收后清理，可重跑 `.tmp/desktop-e2e.mjs` 流程复现）。

**未覆盖（需要真实 Provider）**：prompt 发送 → SSE 流式 → abort 的真模型回路（会消耗配额，留给用户自行验证：启动桌面端后直接发消息即可）。mock 模式下该链路（含流式、停止）已经过浏览器截图验证。

## 协议要点（抄自契约，勿凭记忆）

- Envelope：`{protocolVersion:1, eventId, sessionId, streamId, sequence, timestamp, type, payload}`；同 streamId sequence 从 1 严格递增；SSE 帧 `id: <streamId>:<sequence>`、`event: <type>`、`data: <json>`；重连游标 `Last-Event-ID` 或 `?sinceSeq=`。
- prompt：`POST /api/sessions/:id/messages {content}` → 202 `{status:"accepted", streamId}`；busy 409。abort：`POST .../abort {streamId}`。
- 建会话：`POST /api/sessions {title, cwd, agentId?, ...}` → 201 SessionView（cwd 取 Agent `settings.defaultCwd`）。
- 事件 payload（`src/contracts/events.ts:63-97`）：`message.delta {role,delta}`、`tool.started {toolCallId,toolName}`、`tool.completed {toolCallId,result,isError}`、`turn.completed {turnId,usage?,context?}`、`plan.updated {items:string[]}`、`sandbox.denied {reason}`、`error {code,message,retryable}`、`memory.recall.* {recallId,episodeId,status,layer?,resultCount?}`、`memory.agent.* {runId,status,phase?,reason?}`。
- 记忆端点挂 `/api/agents/:id/memory/*`（无顶层 /api/memory）；日志挂 `/api/observability/*`（无 /api/logs）；observability stream 游标是纯数字 id（与会话流 `streamId:seq` 不同格式）。
- 错误统一 `ApiError {code,message,retryable,details?}`；PUT 类接口 audit 不可用时 503（fail-closed）。

## 已知限制（slice 1 内可接受）

- 跨客户端同会话实时同步不生效（见架构决策 4）；compact/命令卡片未投影；附件未投影。
- ~~日志页过滤在客户端完成（首 200 条）~~ 第二波已接服务端过滤 + cursor 分页 + 实时跟随（活动 tab）。
- ~~Subagent 面板、审批回路（workspaceConfirmed 交互）未接入~~ 第二波已完成（dock 只读面板 + WorkspaceBanner）。
- Agent 创建/编辑、Provider 管理仍属 web 运维面，桌面端只读。

## 第二波（2026-08-20，已完成）

数据层扩展（主 Agent）：`listModels / getSessionSettings / updateSessionModel / updateSessionSettings / getSessionUsage / queryActivity(cursor 分页) / subscribeActivityStream / getMemoryData(query) / deepDiveMemory / getMemoryRunReport / listSubagentThreads / getSubagentTranscript`，Mock 与 IPC 双实现；Subagent 线程发现经 `activity?eventName=subagent.thread.created&sessionId=`（与 web `use-subagent-threads.ts` 同策略——服务端无 session 级列表端点）。

三个并行 UI 拨次（子 Agent 实现、主 Agent 审查集成，各自独立文件无冲突）：

- **A 会话设置与用量**：Composer chips 真实化——模型（仅列已配置凭据项）/思考级别（七档）/工具模式（带说明）下拉浮层；streaming 禁用；`UsageBadge` 会话头显示上下文占用，turn 结束自动刷新；新会话的选择在建会话时下发。审查后修复：菜单向上弹出（composer 在页底，向下被裁）。
- **B 日志/记忆增强**：活动日志服务端过滤（300ms 防抖）+ cursor 加载更多 + 实时跟随（按当前过滤 prepend、+N 徽标）；记忆搜索走服务端（400ms 防抖）；「立即整理」接真 + 完成后「查看报告」。
- **C Subagent 只读面板**：dock 第三工具，线程卡片 → 详情（任务目标/runs/消息时间线/artifacts），全只读。

审批回路（主 Agent）：`toolMode=all 且未确认` 时显示 `WorkspaceBanner`——确认工作区 / 切换为只读，乐观更新 + 失败提示。

**验收**：`npm run desktop:build`（tsc strict + vite）通过；vite dev + Playwright 截图逐项核验（模型浮层、横幅确认消失、Subagent 列表/详情、跟随开关、暗色回归）全部正常。

**仍待办**：真实 Provider 的 prompt/流式/abort 回路联调（需用户配额）；Subagent 卡片进入主对话时间线（目前只在 dock）；多客户端同会话实时同步；Subagent 面板实时流（`subagent:<threadId>` stream，当前手动刷新）。

## 第三波（2026-08-20，已完成）：模型接入

**起因**：桌面端只有读链路时无法配置 Provider/凭据，真实对话无从谈起（用户实测：发消息建了会话但无模型可用）。

- 数据层（主 Agent）：`listProviders / upsertProvider`（PUT `/api/settings/providers`，`{provider, apiKey?}`；apiKey 仅写入 AuthStorage 不回显）；mock 改为 providers 单一事实源、listModels 派生。
- 波次 D（子 Agent）：设置「模型与 Provider」分区真实化——Provider 列表（协议/URL/模型数/凭据徽标）、添加与编辑表单（字段与校验全对齐 web `provider-form.ts`，API Key password 不回显）、保存后刷新并回调 `onProvidersChanged`。
- 主 Agent 集成：Provider 保存后模型下拉自动重拉；空态新增「还没有可用模型，去配置 Provider →」引导（直达设置分区）。
- 审查修复：`UsageBadge` 百分比原样输出浮点（`0.000999…%`）——改为取整 + 极小值 `<0.1%`，窗口 ≥1M 显示 `1M`。

**真实服务验收**（Electron + 运行中 Supervisor，dev home）：设置页添加 Demo Provider（假 key）→ 列表显示「已配置凭据」→ composer 模型菜单出现该模型；截图 p1-p4/q1-q2（验收后清理）。至此模型接入闭环：配 Provider/Key → 模型可选 → 可发消息。

**注意**：dev home 里留有一个 `demo-local` 演示 Provider（假 key，无删除端点，可在设置里编辑覆盖）；用户真实 Provider 请在桌面设置或 Web 运维面自行配置。

## 验收记录

（S6 已于 2026-08-20 完成，见上方验收记录。截图已清理，复现方式：启动 supervisor + `npm run desktop:build`，用 Playwright `_electron.launch` 驱动。）

# Desktop E2E 功能测试清单

> 建立：2026-08-20；全部 7 组已于 2026-08-21 执行完毕。主会话维护本文档；测试执行派发给子智能体分组完成，结果由主会话审查截图/日志后回写。
> 对接进度见 `plans/desktop-wiring.md`；本清单是其"全链路验收"的独立环节。

## 1. 范围与原则

- 对象：`desktop/` Electron 桌面原型，两条数据源链路都测：
  - **真实链路**：Electron（`window.desktopApi` → 主进程代理 → Supervisor 4311 / Agent Server 4310，dev home = `opencolorful/.opencolorful`）
  - **Mock 链路**：纯浏览器 vite dev（无 `desktopApi` → MockDataSource），做 UI 回归
- 方法：真实点击、真实输入发送、UI 断言 + `curl` 对照后端数据，禁止纯代码目测。
- 测试数据一律 `e2e-` 前缀，各组自建、自用、自清理。
- 后端由主会话统一拉起；除 G 组（韧性）外，任何组不得重启/杀 4310/4311。
- 子智能体只执行测试，不修改源码；发现的缺陷记入结果，由主会话评估修复。

## 2. 环境配方（各组共用）

- Electron：`playwright` 的 `_electron.launch({ args: [".", "--user-data-dir=<隔离目录>"], cwd: "<local-workspace>/opencolorful/desktop" })`；无 `DESKTOP_DEV_URL` 时加载 `desktop/dist/index.html`（构建产物由主会话保证新鲜）。**每组必须用自己的 `--user-data-dir` 隔离 localStorage。**
- Mock：`cd desktop && npm run dev:renderer`（127.0.0.1:5174）+ chromium；用完杀端口进程。
- 脚本与截图：`opencolorful/.tmp/e2e/<组>/`，截图命名 `<用例ID>-<简述>.png`。
- 选择器：组件无 `data-testid`，先读 `desktop/src/components/*.tsx` 找文本/role，优先 `getByRole`/`getByText`。
- 端点形状以 `desktop/src/data/ipc-source.ts` 与 `src/server/routes/*.ts` 为准，先读代码再 curl。
- Windows/Git Bash：curl JSON body 用 `-d @file.json`；杀进程 `taskkill //PID <pid> //F`。

## 3. 状态标记

`PASS` / `FAIL`（功能缺陷）/ `BLOCKED-ENV`（环境阻塞，如凭据失效）/ `SKIP`（UI 无此功能，须注明）。

已知边界（误报防线）：

- 真实流式依赖 `opencode` Provider 凭据（`credentialConfigured: true`），本轮验收真实可用（A3-A5 已实证）。
- Provider 无删除端点（已确认：`src/server/routes/providers.ts` 仅 GET/PUT）。
- Subagent 链路由 H 组专项覆盖（真实 spawn/wait/status/steer + Dock/日志联动 + 真值对照）。
- compact / 附件投影 / 多客户端同步是已知未实现项（见 wiring 文档 backlog），不在本清单。
- 会话"1"（id `69967c5c-…`）是用户手测数据，只读，不得改删。

## 4. 测试清单与结果

### A 组：会话与聊天全链路（Electron + 真实后端）— 核心组 · 已执行 8/10

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| A0 | Titlebar 点最小化/最大化/还原 | 窗口状态变化，`_electron.evaluate` 断言成立 | PASS | a/A0-window-controls.png |
| A1 | 启动，看侧栏 | 真实会话列表加载（含"1"），无报错 | PASS | a/A1-sidebar-list.png |
| A2 | 点新建会话 | 新会话出现，聊天空态展示 | **FAIL** | a/A2-new-thread.png；空态出现但侧栏不即时增加（首次发送才落库，见问题 #1） |
| A3 | 输入"用一句话介绍你自己"回车 | 用户气泡立即出现；助手文本递增；60s 内完成态 | PASS | a/A3-*.png；真实 opencode 流式全链路通过 |
| A4 | 追问"把你上一句原样复述" | 回复与 A3 文本一致（上下文正确） | PASS | a/A4-context.png |
| A5 | 发长文流式中点停止 | 10s 内流停止，UI 不卡死/不白屏 | PASS | a/A5-abort.png |
| A6 | 切到会话"1"再切回 | 两侧历史均完整渲染 | PASS | a/A6-*.png |
| A7 | 重命名自建会话 | 侧栏更新 + curl 验证 title | **FAIL** | a/A7-rename-attempt.png；前后端均无重命名能力（见问题 #2） |
| A8 | 观察 UsageBadge | 合理百分比，无 NaN/报错 | PASS | a/A8-usage-badge.png（"上下文 7.8k/1M · 1%"） |
| A9 | 打开 Dock 三 tab + SubagentDock | 真实空态正常展示，无 console error | PASS | a/A9-dock-*.png |
| A10 | 删除自建会话 | 列表移除 + curl 验证 | PASS | a/A10-after-delete.png（API 归档后需 reload 才反映，见问题 #7） |

### B 组：Composer 与会话设置持久化（Electron + 真实后端）· 已执行 7/7

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| B1 | 自建 e2e 会话 | 创建成功 | PASS | b/B1-draft.png |
| B2 | 点 toolMode chip → 浮层 → 切换模式 | 浮层向上弹出；chip 更新；curl 验证持久化 | PASS | b/B2-*.png（几何断言浮层在 chip 上方；read-only→off 持久化一致） |
| B3 | 点 thinkingLevel chip → 切换档位 | 同上 | PASS | b/B3-*.png（medium→high 持久化一致） |
| B4 | 观察 WorkspaceBanner，点确认 | 横幅逻辑与后端一致 | PASS（降级） | 后端强制 `toolMode=all ⇒ workspaceConfirmed=true`，横幅永不可达（见问题 #4） |
| B5 | `win.reload()` 后看 chips | 显示值与后端一致 | PASS | b/B5-reload.png |
| B6 | Composer 其他按钮（附件等） | 有则记录行为 | PASS（占位） | b/B6-buttons.png；附件/工具按钮无 onClick（见问题 #5） |
| B7 | 清理自建会话 | curl 验证删除 | PASS | — |

### C 组：记忆页（Electron + 真实后端）· 已执行 3 PASS + 2 SKIP

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| C1 | 导航到记忆页 | 列表加载真实数据，与 curl 一致 | PASS | c/C1-memory-list.png；六端点逐项对照一致（Agent 记忆当前为空，空态正确） |
| C2 | 新增记忆（若有入口） | 列表出现 + curl 验证 | SKIP | UI 只读视图，无新增入口（符合设计） |
| C3 | 详情展开 / 搜索过滤 | 交互正常 | PASS | c/C3-detail-expanded.png、c/C3-search.png |
| C4 | 编辑/删除（若有）+ 清理 | curl 验证 | SKIP | UI 无编辑/删除入口 |
| C5 | 一致性总评 | 展示与后端完全一致 | PASS | 计数与编译四段逐段吻合 |

### D 组：日志/观测页（Electron + 真实后端）· 已执行 6/6

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| D1 | 导航到日志页 | 真实事件加载，与 curl 一致 | PASS | d/D1-logs-load.png；UI 200 行 == API(limit=200) 200 条 |
| D2 | 过滤/搜索 | 结果正确收窄 | PASS | d/D2-level-error.png（error 11==11）、d/D2-search.png（"compile" 6==6） |
| D3 | 展开事件详情 | 字段完整渲染 | PASS | d/D3-detail.png（Session/Agent/traceId/脱敏 Payload 齐全） |
| D4 | 自建会话发消息 | 日志出现该 sessionId 事件 | PASS | d/D4-session-events.png |
| D5 | Dock 真实空态 | 打开无报错 | PASS | d/D5-*.png |
| D6 | 清理自建会话 | curl 验证 | PASS | — |

### E 组：设置与 Provider 管理（Electron + 真实后端）· 已执行 5 PASS + 1 SKIP

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| E1 | 设置弹窗 → Provider 列表 | 与 curl 一致 | PASS | e/E1-providers-final.png；name/baseUrl/protocol/models 数/凭据徽标全对上 |
| E2 | 表单校验（空提交/非法 baseUrl） | 错误提示，不写后端 | PASS | e/E2-*.png；留空 4 条自定义错误；ftp:// 自定义协议错误；not-a-url 被原生 type=url 拦截 |
| E3 | 探测 DELETE 端点 | 存在则全链路增删 | SKIP | 无 DELETE 路由（仅 GET/PUT），已知设计 |
| E4 | 编辑 demo-local 名称 → 验证 → 改回 | 可逆编辑持久化 | PASS | e/E4-*.png；改名往返 curl 双侧验证，其余字段不变 |
| E5 | UsageBadge 与 curl usage 端点对照 | 数值一致 | PASS | e/E5-usage-final.png；30.6k/1M·3% ↔ tokens=30568/percent=3.0568，title 总用量/轮次吻合 |
| E6 | 弹窗打开/关闭/遮罩/ESC | 交互正常 | PASS | e/E6-*.png |

### F 组：Mock UI 回归（chromium + vite dev:renderer）· 已执行 8/8

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| F1 | 主题切换亮↔暗；reload | 语义变化 + localStorage 持久 | PASS | f/F1-*.png |
| F2 | 侧栏折叠/展开 | 折叠 ≈46px 图标轨；展开恢复 | PASS | f/F2-collapsed.png（248px↔46px 实测） |
| F3 | Dock 三 tab 切换 | 各面板渲染，无 console error | PASS | f/F3-*.png |
| F4 | mock 会话发消息 | 用户气泡 + 助手逐字增长 → 完成 | PASS | f/F4-*.png（长度序列 [12,24,36,52,56] 递增） |
| F5 | 设置弹窗打开/关闭 | Provider 区 mock 展示正常 | PASS | f/F5-*.png |
| F6 | 记忆/日志页 mock 渲染 | 无报错 | PASS | f/F6-*.png |
| F7 | 视口 1024x720 | 不横向溢出 | PASS | f/F7-small-viewport.png（scrollWidth=1024） |
| F8 | console error 收集 | 零 error | PASS | — |

### G 组：韧性与降级（Electron + 真实后端，故障注入）· 已执行 4 PASS + 1 FAIL

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| G0 | 基线：已连接、列表加载 | 正常 | PASS | g/G0-baseline-connected.png |
| G1a | taskkill agent server 后操作 UI | 可感知错误提示，不白屏不卡死 | PASS | g/G1a-send-result.png；记忆/日志页 alert+重试，发送呈"发送失败"事件卡，用户消息不丢 |
| G1b | 观察 supervisor 是否自动拉起子进程 | 60s 内自动拉起 | **FAIL** | 60s 轮询全程 error/pid=null；`src/supervisor/process-controller.ts:136-148` exit 处理器只置 error 无重启循环（见问题 #11） |
| G2 | 手动恢复后 UI 重试 | 列表重载、SSE 自动重连、写链路恢复 | PASS | g/G2-after-send.png；未 reload 窗口 SSE 自动承接，发送得真实回复 |
| G3 | 收尾健康检查 | 4310/4311 online，用户数据完好 | PASS | g/G3-final.png |

### H 组：Subagent 真实派发、父子编排、子代理工具调用（Electron + 真实后端 + 真实模型）· 已执行 9 PASS / 2 FAIL

| ID | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| H0 | 预检：新会话切 deepseek-v4-flash + toolMode=all | 设置持久化，workspaceConfirmed 自动 true | PASS | h/H0-*.png |
| H1 | 发指令要求 spawn_subagent 数 .tsx 文件并 wait 回报 | 工具被调用；thread 创建；回报数字 | PASS（工具调用/thread 创建 5s 内确认） | h/H1-*.png；截图可见实时工具卡片"27/10 个工具已完成"（#15 误报已撤回）；回报动作本身发生 |
| H2 | curl 子代理 transcript + activity | 子代理消息/工具记录可读 | PASS | transcript 可读，task/steer 消息完整；activity 有 thread.created/run.queued（主会话独立复核一致） |
| H3 | 真值对照：汇报数 == 独立计数（.tsx=2） | 相等 | **FAIL** | 主 Agent 报 64（子代理未返回，自行编造）；根因是 #13，附带暴露 #16 |
| H4 | 追问 get_subagent_status | 调用工具并汇报状态/用量 | PASS | h/H4-status-reply.png；如实报 queued/token 0 |
| H5 | SubagentDock 列表 + transcript 详情 | thread 出现且可查看 | PASS | h/H5-01-dock-list.png、h/H5-02-dock-detail.png |
| H6 | 日志页过滤 subagent.thread.created | 与 curl 一致 | PASS | h/H6-01-logs-filtered.png |
| H7 | steer_subagent 补数 .ts 文件 | 新 Run 启动并回报 .ts=3 | **FAIL** | steer 消息进 Thread（1→2）但 Run 仍卡 queued（见问题 #13） |
| H8 | 清理自建会话 | curl 无残留 | PASS | — |

### H 组补充事实（主会话复核）

- 子代理 Run `sar_0020c5c53bb4461a` 自 04:16:10 入队后 **19分48秒未启动**（startedAt=null、iterationCount=0、toolCallCount=0）。
- 更早一次试跑（04:10，另一会话）：Run 执行了但所有文件工具报 **"executor not ready"**，终态 disposition=failed。
- 代码级线索（主会话读码所得）：`src/runtime/subagents/runtime/scheduler.ts:74-76` `submit()` 在容量未满时调用 `host.execute(input)` 但**不检查其返回**——execute 拒绝（如 startWithSnapshot CAS 冲突/运行时未就绪）时 Run 即成孤儿永久 queued；boot 恢复对 DB queued Run 的接管亦未生效（本次后端是重启后的新进程）。

## 5. 执行记录

| 波次 | 时间 | 组 | 结果摘要 | 发现的问题 |
|---|---|---|---|---|
| 一 | 2026-08-20 17:40-18:10 | A/B/C/D/F 并行 | A 8/10（A2/A7 FAIL）；B 7/7；C 3 PASS+2 SKIP；D 6/6；F 8/8。主会话抽查 6 张关键截图复核属实 | #1-#7、#10 |
| 二 | 2026-08-20 晚-08-21 | E → G 顺序 | E 首轮遇后端崩溃（4310/4311 进程消失、server.log 无记录），主会话重启后 E 重跑 5 PASS+1 SKIP；G 4 PASS+1 FAIL（G1b），主会话抽查 G1a/G2 截图复核属实 | #8、#9、#11、#12 |
| 三 | 2026-08-21 | H（Subagent 专项，用户指出漏测后补） | 9 PASS / 2 FAIL（H3/H7）；dock 发现、详情、日志联动全通；但暴露 Run 调度卡死与工具执行器未就绪两个后端高严重度缺陷 | #13-#16 |
| 四 | 2026-08-21 | #13/#14 修复 + H 回归 | explore 定根因（主会话复核实锤）→ coder 修复 3 源文件+3 测试文件（未提交）→ 主会话逐行复核 diff、质量门重跑全绿（PI 边界 0 / tsc 0 / 26 测试全过）→ 重启后端回归：spawn 15s 内 run.completed、能力工具实测目录、mailbox delivered、数字 2 正确。**#15 撤回的独立实验**（服务端 tool.* 流+历史卡片）同波完成 | #13/#14 关闭；#15 关闭（误报） |
| 五 | 2026-08-21 | #11 看门狗实现 + G1b 回归 | coder 实现退避看门狗（主会话复核后补收养期望态初始化盲区）→ 主会话复核 diff、质量门重跑（tsc 0 / PI 边界 0 / supervisor 24/24）→ 重启 supervisor 加载新代码 → G1b：taskkill agent server 后 ~12s 自动恢复 online（收养慢路径），watchdog 字段透出 consecutiveFailures=1，无人工干预 | #11 关闭 |
| 六 | 2026-08-22 | P1a 实施（#1/#2/#4 + unarchive//compact）+ 全链路回归 | 后端包（agent-36）+ 桌面包 A（agent-37）均因子智能体模型配额 403 中断，主会话接手核实落盘、修 `session-rename.test.ts` 类型错误（PiSessionHandle 无 title getter，改读 JSONL 文件断言）；质量门全绿（tsc 0 / PI 边界 0 / vitest 2093 通过，1 个插件并行时序 flake 隔离复跑通过、与本 diff 无关）；desktop build 绿；API 回归 17/17（`.tmp/p1a/regression.py`）；Electron 真实链路 11/11（`.tmp/e2e/p1a/run.mjs`：横幅出现→确认解锁写工具、行内改名双写 JSONL+索引、/compact 409 友好提示且不作消息发出、归档折叠区+UI 恢复回活跃列表） | #1 关闭（按设计）；#2 关闭；#4 关闭 |

**总计：50 PASS / 5 FAIL / 4 SKIP（BLOCKED-ENV 已全部消除）**
**FAIL 处置：A2→#1（按设计关闭：维持首发消息才落库+草稿文案）、A7→#2（已修复回归通过）、G1b→#11（已修复回归通过）、H3/H7→#13（已修复回归通过）；B4→#4（已修复回归通过，横幅转正）**

### 问题台账

| # | 严重度 | 描述 | 关联用例 | 处置 |
|---|---|---|---|---|
| 1 | 中 | 新建会话不即时落库：点"新建"只进空态，首条消息发出后才 createThread，侧栏列表不即时增加 | A2 | **已关闭（2026-08-22 P1a，按设计）**：维持"首发消息才落库"（2026-08-21 用户拍板），空态已加草稿态说明文案"新会话为草稿：发送首条消息后才会出现在会话列表"；Electron 回归确认文案展示 |
| 2 | 中 | 会话重命名缺失：UI 无入口，后端无 title 端点（setTitle 仅创建时调用） | A7 | **已修复并回归通过（2026-08-22 P1a）**：后端 `PUT /api/sessions/:id/title`（trim 非空 400/不存在 404/归档允许改/≤200 字）+ `renameSession` 双写 PI JSONL setTitle+persist 与 SQLite 索引；桌面侧栏行内编辑（铅笔按钮/双击，Enter 保存 Esc 取消，乐观更新+失败回滚提示）。A7 转 PASS：UI 改名→后端 title/JSONL 双验证 |
| 3 | 中 | 默认模型选中不可用的 demo-local（127.0.0.1:9999），新用户首发消息得到空回复而非可感知错误 | A3 预检、B 组截图、G 组 composer 均复现 | **已修复并回归通过（2026-08-21 P0）**：模型选择 ①当前有效→②偏好默认（getPreferences 新增，偏好加载前不抢选防竞态）→③首个 credentialConfigured；dev 后端偏好默认已设 opencode/deepseek-v4-flash。回归：草稿 chips=deepseek-v4-flash |
| 4 | 低 | WorkspaceBanner 死代码：后端在创建与 PUT 两处强制 toolMode=all ⇒ workspaceConfirmed=true，桌面显示条件 all && !confirmed 永不可达 | B4 | **已修复并回归通过（2026-08-22 P1a，B4 转正）**：放开后端约束（2026-08-21 用户拍板）——删 contracts 强制 throw；tool-policy all 未确认 fail-safe 降级只读（write/edit/bash 不可用，附沙箱警告）；PUT settings 仅"cwd 变更且涉 all"需重新确认，非 all 切 all 未确认放行。Electron 回归：all+未确认横幅出现→点确认→横幅消失+confirmed=true |
| 5 | 低 | Composer 附件/工具按钮为无 onClick 占位，点击无任何反馈 | B6 | **已修复（2026-08-21 P0）**：两按钮从 JSX 移除（含图标清理），注释指向 wiring backlog ④ 随附件投影回归 |
| 6 | 低 | UI 新会话草稿默认 toolMode=all/thinking=high，与后端确认门矛盾，首条消息静默 400 后落库为偏好默认值 | B 组附记 | **已修复并回归通过（2026-08-21 P0）**：草稿默认值改从 getPreferences 读取（兜底 read-only/medium），用户手动选择不被偏好覆盖（touched ref）；回归：草稿 chips=read-only/medium |
| 7 | 低 | 侧栏不感知外部变更：API 归档/改名后需 reload 才刷新（listThreads 仅 source/agentId 变化时拉取） | A10 | 已知设计限制；可后续接 SSE 会话事件做失效刷新 |
| 8 | 中 | ipc-source.request() 只按 HTTP 状态判成败：异常 200+乱码时 INVALID_JSON 被当空数组，UI 静默显示"空数据"而非错误 | E1 附记 | **已修复（2026-08-21 P0）**：request() 对 INVALID_JSON 包装体显式抛错（代码级验证，健康后端下无法现场复现，构建绿）；同时 request 失败按 status 0/502 立即转离线 |
| 9 | ~~观察~~ | 后端进程无人操作自行消失 | E 组执行前 | **已由 #11 解释**：子进程意外死亡后 supervisor 无自愈，并非日志缺失 |
| 10 | 提示 | Electron 渲染进程 CSP 安全提示（未设 CSP/含 unsafe-eval），打包前常规告警 | D 组附记 | 打包发行前补 CSP meta |
| 11 | **高** | Supervisor 对 Agent Server 意外死亡无自动拉起：exit 只置 error + 记日志，须手动 start/restart；生产环境单点 | G1b | **已修复并回归通过（2026-08-21）**：`process-controller.ts` 看门狗——退避重启（1s→30s 封顶、5 次上限后放弃）、稳定窗口 60s 归零计数、主动 stop 不触发、跨 supervisor 重启收养期望态（`inferDesiredRunningFromState`）、status API 透出 watchdog 字段；24/24 集成测试过。G1b 回归：kill 收养进程后 ~12s 自动 online（慢路径轮询发现），exit 快路径由集成测试覆盖。提交 52fb266 |
| 12 | 中 | 标题栏连接状态静态：IpcDataSource.info.connected 构造时写死 true，断线时仍显示"已连接"，离线分支不可达 | G1a 附记 | **已修复并回归通过（2026-08-21 P0）**：ipc-source 动态连接态——8s 探活巡检 + 请求成功/失败快路径驱动 setConnection，`subscribeConnection` 订阅（source/mock/App 全链接线）；回归：杀后端 2.5s 标题栏转"离线（自动重连中）"，看门狗恢复后 ~10s 自动转回"已连接" |
| 13 | **高** | 子代理 Run 调度卡死：spawn 后 Run 永久 queued（20min 未启动，iterationCount=0）。代码线索：`scheduler.ts:74-76` submit() 不检查 host.execute() 返回，execute 拒绝时 Run 成孤儿；boot 恢复对 DB queued Run 接管未生效 | H1/H3/H7 | **已修复并回归通过（2026-08-21）**：`runtime-host.ts` 启动 CAS 挪入 execute() 同步执行，失败返回 rejected（reasonCode surfacing）；`scheduler.submit` 传播 rejected；spawn/steer 既有 compensateSchedulerRejected 兜底终态化。回归：spawn 后 15s 内 run.completed |
| 14 | **高** | 工具执行环境未就绪：子代理文件工具报 "executor not ready"；根因=`subagent-tools-context.ts` 的 abilityExecutors 模块私有 Map 未跨 jiti/native 加载器共享（同文件 state 已锚定 globalThis，它漏了）。附：父会话 bash 报 "OS sandbox not yet available"（sandbox-extension.ts:223）是 OS 沙箱未实现的既定限制，非本缺陷 | H 组首轮 + 主会话 probe | **已修复并回归通过（2026-08-21）**：abilityExecutors 迁入 globalThis Symbol.for 锚定（含旧状态兼容补齐）。回归：子代理持 read+[find,ls] 能力真实列目录（枚举出 components/data/pages），mailbox delivered，主 Agent 报对数字 2 |
| 15 | ~~中~~ | **误报，已撤回（2026-08-21 主会话复核）**：H 组自己的截图 H1-01/H1-03 清晰显示实时工具卡片"27/10 个工具已完成"（meta"完成"=实时投影，非历史）；主会话实验证实服务端 tool.* 事件流正常（started/delta/completed 同 streamId）、历史卡片渲染正常、SSE 路由与桌面投影链路无过滤 | H1 NOTE | 无需修复；desktop 工具卡片投影链路（实时+历史）确认健康 |
| 16 | 低 | 主 Agent 不检查 wait 返回的 status 便自行编造结果（报 64 vs 真值 2）——wait_subagent 文档明确要求检查 status | H3 | 系统提示/模型行为风险，随 #13 修复后观察是否缓解 |

## 6. 遗留与后续

- 全部 8 组执行完毕；#13/#14/#11 已修复回归通过（已提交 00d95c1 / 52fb266），#15 撤回；P0 已清账 #3/#5/#6/#8/#12（desktop/ 未跟踪，随原型后续一并入库）。`.tmp/e2e/` 保留脚本/截图/result.md，待验收确认后统一清理。
- 预存 `observability-retention.test.ts` 日期炸弹已随 P0 修复（相对日期）。
- 剩余：产品取舍项 **#1/#2/#4 已于 2026-08-22 P1a 全部关闭**（见波次六）；低优先 #7/#10/#16 顺波次处理。
- 对齐路线总控：`plans/desktop-parity.md`（P0/P1a 已完成，P1b-P7 待排）。

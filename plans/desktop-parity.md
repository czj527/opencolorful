# Desktop 全能力对齐路线图

> 建立：2026-08-21。范围决策（用户）：**Cordis 插件化嵌入搁置；后端已实现的所有功能都要进桌面端**。
> 本文档是对齐工作的总控计划，事实底座为当日全量盘点（后端 ~90 端点 / web 9 页面域 / desktop 22+ 数据源方法）。
> 执行记录与问题台账仍归 `plans/desktop-e2e-test-plan.md`；对接细节归 `plans/desktop-wiring.md`。
> **2026-08-26 起并入 P1 产品轨道**（见 `plans/g1-repo-convergence.md` 与 P1 切片 1 规格 `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`）；内部波次编号由 P 改为 D（D0-D7），避免与产品路线 P1-P3 冲突。

## 1. 现状三段论

**已对接真实后端**（E2E 验证过）：会话列表/新建（简式）/归档/**恢复/重命名//compact**/、消息流式/abort、会话设置（toolMode/thinking/model，**含 all+未确认横幅确认流**）、Provider 管理（列表/添加/编辑）、记忆只读六端点+立即整理、日志活动页（过滤/搜索/详情）、SubagentDock（发现+transcript）、UsageBadge、Supervisor 连接与代理。

**web 有、桌面缺**（对齐主体）：

| 域 | 关键端点 | web 页面 |
|---|---|---|
| Agent 管理 | `POST /api/agents`、`PUT /api/agents/:id`、`GET/PUT base-color`、`GET/PUT settings`、`POST archive`、`GET templates` | agent-new / agent-edit |
| 新建会话完整表单 | `POST /api/sessions`（完整运行设置）+ `/api/directories/pick` | session-new |
| 会话维护 | `POST /api/sessions/:id/unarchive`、`POST .../compact`、重命名（**前后端都缺**，台账 #2） | workspace |
| Subagent 深化 | `GET .../threads/:tid/stream`（SSE 实时）、`.../artifacts` + `.../artifacts/:aid/content` | workspace（web 有卡片进时间线） |
| 插件中心 | `/api/plugins` 全组（inspect/install/启停/update/rollback/卸载/diagnostics/secrets/来源搜索/Agent 绑定） | plugins |
| Skills 目录 | `/api/skills` 全组（search/inspect/install 四态/confirmation 审批/来源信任/bundles/文件树/正文/学习策略/Agent+会话绑定） | skills |
| 日志运维台完整版 | `traces/:traceId`、`errors`、`metrics`、`diagnostic/tail`、`export`、`retention preview/run`、`audit/reset`、`observability/health`、`preferences/observability` | logs |
| 记忆高级 | `GET/PUT .../memory/settings`、`deep-dive/rollback`、`runs/:runId`、`preferences/memory` | memory |
| 用量与偏好 | `GET /api/usage/summary?days=`、`GET/PUT /api/settings/preferences` | settings |
| 沙箱 | `GET /api/sandbox/status`、`GET /api/sandbox/rules/:agentId` | agent-edit 一部分 |

**暂不进桌面**（与 Cordis 同取舍，待拍板）：插件 dev 开发循环工具链（`/api/plugins/dev/*`，开发者功能）、`/api/observability/client-events`（客户端上报，桌面自身是被测面）。

**横贯技术债**：多客户端同会话同步（⑤设计限制，需 WS `/ws` 或 SSE 失效刷新，连带解决台账 #7）；Electron 原生目录选择对话框（替代 web 的 `/api/directories/pick`，更原生）。

## 2. 波次规划

### D0 桌面小修与一致性（先行清账）
- 台账 #3 默认模型选可用 provider（ credentialConfigured 优先）；#12 连接状态动态化（SSE 重连/探活驱动 Titlebar）；#8 INVALID_JSON 显式抛错；#5 附件/工具占位按钮隐藏或禁用；#6 草稿默认值对齐偏好默认。
- 顺手修预存 `observability-retention.test.ts` 日期炸弹。
- 验收：A3 预检场景、G1a 断线场景、E1 异常响应场景各自回归。

### D1 聊天主干补齐
- **D1a（已完成 2026-08-22）**：`unarchive`（归档折叠区+恢复）；`/compact` 命令入口（409 会话忙友好提示，projector 压缩卡片已有）；会话重命名（后端 `PUT /api/sessions/:id/title` + session-service renameSession 双写 JSONL/索引 + 侧栏行内编辑，台账 #2）；WorkspaceBanner 放开（删 contracts 强制 throw、tool-policy all 未确认 fail-safe 降级只读、PUT settings 仅 cwd 变更涉 all 需重新确认，台账 #4）；新建会话维持"首发消息才落库"+空态草稿态文案（台账 #1 按设计关闭）。
- **D1b（待排，P1 切片 1 组成部分）**：完整新建会话表单（对齐 web session-new：title/cwd/agent/toolMode/thinking/model/workspace）；Electron 原生目录选择（`dialog.showOpenDialog` 经 preload 暴露，替代 pick 端点）。
- 验收：A2（按设计）/A7 转 PASS；B4 转正（横幅可达、确认后解锁写工具）。

### D2 Subagent 完整观察
- Subagent 卡片进主时间线（backlog ②：thread.created/steer/结果摘要投影为 event 卡，可跳 Dock）；SubagentDock 实时流（backlog ③：`GET .../threads/:tid/stream` SSE，纯数字游标 + snapshot/reset 帧型，ipc-source 加 `subscribeSubagentStream`，替换手动刷新）；artifacts 列表与受控下载（`.../artifacts` + `.../artifacts/:aid/content`，Electron 侧 save dialog 落盘）；run 状态徽标与取消按钮（`cancel` 走主 Agent 工具不可行——确认是否有面向用户的取消端点，无则只做状态展示并标注）。
- 验收：H 组用例扩展（H5 实时性、H9 卡片进时间线、H10 artifact 下载）。

### D3 Agent 管理
- Agent 创建页（对齐 agent-new：名称/底色模板/settings/沙箱路径）、编辑页（含 base-color 编辑器）、归档/列表刷新；原生目录选择复用 D1b 成果。
- 验收：新增 C 组式 CRUD 用例（创建→编辑→归档全链 + curl 对照）。

### D4 插件中心
- 列表/详情/启停/卸载/诊断；安装流（inspect → 风险确认 → install）与 update/rollback；Agent 绑定管理（`/api/agents/:aid/plugins`）；secrets 管理（只写不读，审计脱敏呈现）；来源搜索。
- 验收：以真实插件 fixture 走安装→启用→绑定→诊断→卸载全链。

### D5 Skills 目录
- catalog 浏览/搜索/详情（文件树+受控正文）；安装四态与一次性审批（confirmation token approve）；Agent 绑定与学习策略；会话级临时安装（`/api/sessions/:sid/skills`）；来源信任与 bundles 浏览。
- 验收：搜索→检查→安装（审批）→会话内可用→绑定持久化全链。

### D6 日志运维台完整版
- traces 树视图、errors 分组、metrics 每日指标、diagnostic tail、export（Electron save dialog）、retention preview/run、audit reset（高危操作加二次确认）、observability health 卡、observability preferences。
- 验收：D 组扩展用例（`desktop-e2e-test-plan.md` 既有 D 组用例，与波次编号无关）。

### D7 记忆高级 + 用量偏好
- per-Agent 记忆设置、deep-dive rollback 与 run 报告、全局记忆偏好；`usage/summary` 用量页（byDay/byModel，极简图表）；全局偏好编辑（defaults/appearance/subagents 默认模型）。
- 验收：C 组扩展用例。

### 横贯（穿插进行）
- 多客户端同会话同步：评估 WS `/ws`（stream.resume）与 SSE 失效刷新两条路，先解台账 #7（侧栏失效刷新），再解同会话双端一致。
- 每个波次完成后按 `desktop-e2e-test-plan.md` 增补对应用例并回写。

## 3. 执行纪律（沿用既有约定）

- 主会话：波次计划、复杂逻辑与 UI 美学、diff 复核、质量门、验收与文档回写。
- 子智能体：波次内常规实现并行派发，各自独立文件；后端补端点（D1a 重命名）先行落地再派前端。
- 每波次：构建绿（`npm run desktop:build`）+ 真实后端 E2E 截图验收 + 文档回写。

## 4. 执行记录

| 波次 | 时间 | 内容 | 结果 |
|---|---|---|---|
| D0 | 2026-08-21 | 台账 #3/#6（agent-34）、#5+retention 日期炸弹（agent-35）、#8/#12（主会话） | 全部完成并回归：草稿 chips=read-only/medium/deepseek-v4-flash（#3/#6 PASS）；杀后端 2.5s 标题栏转离线、看门狗恢复后 ~10s 自动转回（#12 PASS）；#8 INVALID_JSON 显式抛错（代码级，构建绿）；#5 占位按钮移除；retention 改相对日期后 1087 单测全绿。desktop build 绿 |
| D1a | 2026-08-22 | 后端包（agent-36：title 端点/renameSession 双写/横幅约束放开/tool-policy 降级）+ 桌面包 A（agent-37：行内编辑/归档区//compact/草稿文案）——两子智能体均因模型配额 403 中断，主会话接手核实落盘、修测试类型错误并全程验收 | 质量门全绿（tsc 0 / PI 边界 0 / vitest 2093 通过，1 个插件并行时序 flake 隔离复跑通过、与本 diff 无关）；desktop build 绿；API 链路回归 17/17（当时临时脚本 `.tmp/p1a/regression.py`）；Electron 真实链路 11/11（`.tmp/e2e/p1a/run.mjs`：横幅出现→确认解锁、行内改名双写、/compact 409 友好提示、归档区+UI 恢复）。**台账 #1（按设计关闭）/#2/#4 关闭**，A7 转 PASS，B4 转正 |

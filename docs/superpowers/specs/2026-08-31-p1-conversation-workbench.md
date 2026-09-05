# P1 波次 B：对话工作台能力

**日期：2026-08-31**  
**状态：进行中（2026-09-05 B0 产品语义已冻结；B1-B7 未实施）**  
**实施计划：** [`plans/p1-conversation-workbench.en.md`](../../../plans/p1-conversation-workbench.en.md)  
**上游路线：** [`docs/positioning-and-roadmap.md`](../../positioning-and-roadmap.md) §五 P1/P2  
**当前状态：** [`docs/project-status.md`](../../project-status.md)

## 一、背景

OpenColorful 当前已经有 Session JSONL、PI SessionManager 的底层 branch/tree/fork 能力、Server session/message 路由，以及 Web 端按用户消息派生的线性时间线导航。Desktop 能显示消息、thinking、tool、plan、memory、compact 和 error 投影。可是这些能力还没有形成产品级的会话工作台：用户不能在 Desktop 中回退并修改、重试、创建独立 Fork、切换旧分支；时间线也只覆盖当前线性分支；压缩完成卡不展示 summary 正文；现有 plan 事件没有一等的 durable session todo writer/store。

本波次参考 OpenCode、OpenHanako、Codex、Hermes Agent 和 Kimi Code 的成熟工作台交互，但保持 OpenColorful 的 Server-first、PI SDK 边界、JSONL 正文事实源、Replay 和 Desktop-first 约束。

## 二、目标

1. 提供可理解且可恢复的回退、修改、重试和 Fork 语义，不破坏旧分支。
2. 提供当前 branch 的线性对话时间线定位，并单独提供 branch switcher/tree 入口。
3. 让 Desktop 用户可以阅读压缩产生的 summary 正文，并看到完整状态。
4. 提供 session-owned、可持久化、可回放的 plan/todo 工具与视图。
5. 让刷新、重启、SSE replay、并发和运行中竞态都有明确行为和验收证据。

## 三、产品语义（2026-09-05 B0 冻结）

本节产品语义已冻结；实现细节、稳定 ID、错误矩阵与 API/事件契约以英文实施计划 §3 为准。修改本节必须先修订本规格再实施。

### 1. 回退并修改与重试共用同一原语

两者都以"选中轮次的用户消息"为支点，在原分支旁边创建新分支：回退并修改带入用户编辑后的新文本，重试沿用原文本（在 assistant 结果上重试时，服务端解析回该轮的用户消息）。旧分支与旧输出永久保留在 JSONL 中，可随时切换回去。运行中的会话必须先停止（服务端返回 409 并提示"会话正在运行，请先停止后再操作"，前端提供停止按钮），服务端绝不静默中止正在运行的任务；压缩进行中同样 409。

### 2. 分支切换与分支头持久化

时间线始终展示"当前分支"。切换旧分支只移动当前视图与后续写入位置，不产生任何新消息；切换结果持久化到 SQLite（分支头元数据），刷新、重启后仍保持。切换后在输入框继续发送即延续该分支，该分支随之成为当前分支。两个客户端同时切换时后写生效，双方都会收到 `session.branch.switched` 事件并刷新。

### 3. Fork 独立会话

从当前状态或选中消息复制"根→目标"路径为全新会话：新会话身份、新 JSONL 文件，记录来源会话与来源节点元数据，标题带来源标记。原会话及其运行时不受任何影响；新会话可独立改名、切换模型、归档。空会话不支持 Fork（400）。会话至少有一条消息才可 Fork。

### 4. 稳定标识

时间线与分支切换器使用稳定 ID：`entryId`（PI 条目 ID，JSONL 永久可溯）、`branchId`（分支叶子条目 ID，派生不存储）、`turnId`（`turn-<用户消息条目ID>`，重启后不变）。刷新、重启、SSE replay 后这些 ID 保持稳定，锚点定位不漂移。

### 5. 时间线与分支 switcher 职责

右侧时间线承担当前分支的线性 turn/entry 定位：点击后滚动到消息并高亮当前节点。branch switcher 是另一种导航职责，显示分支列表、父子关系和当前分支，并执行切换；不把线性时间线变成复杂树。

### 6. 压缩摘要

沿用现有 `session.compacting`/`session.compacted` 事件与 payload，服务端压缩行为与默认值不变。Desktop 完成卡显示 tokens 前后（后值为估算，界面标注"约"）与 summary 正文（服务端已脱敏至 500 字符以内，前端不再二次截断），支持展开/折叠，长摘要默认折叠。压缩中止（已中止）与失败（含错误信息）分别显示；无需压缩与忙时沿用现有 409 中文提示，不显示卡片。summary 正文不得写入日志。

### 7. Session plan/todo

Todo 属于会话，仅由第一方工具在轮次执行中写入（会话单飞串行化），UI 只做只读投影，不得自行伪造计划完成状态。条目字段：`content`、`status`（至少 `pending`/`in_progress`/`completed`/`cancelled`）、`priority`（`high`/`medium`/`low`）、可选 `activeForm`。更新采用整表替换，单事务写入 SQLite，成功后发布 `todo.updated` Replay 事件；空列表是合法的显式清空。工具结果必须告知模型写入是否被接受。存储层不强制"至多一项进行中"，由工具描述约定，UI 将第一个 `in_progress` 显示为活跃项。现有 `plan.updated` 契约保持不变且不新增发射方，durable 事实面是 `todo.updated`。

### 8. 错误与文案

所有负例返回稳定错误码与可操作的中文文案（404 节点不存在、400 输入非法、409 运行中/已归档），具体矩阵见英文实施计划 §3.4。

## 四、范围

- PI SessionManager branch/tree/fork/reset/navigate 的受控平台适配。
- Session/branch 元数据、HTTP 契约、稳定 ID、错误和重启恢复。
- Desktop branch switcher、当前 branch 线性 timeline 和定位。
- Desktop compaction summary 正文展示。
- durable session-owned plan/todo writer、store、route、event、projection 和视图。
- Mock UI、API/集成、Replay、多客户端、并发、恢复和 Electron 真链路验收。

## 五、非目标

- 不把 PI SDK 的底层 API 原样暴露给用户。
- 不把消息正文从 PI JSONL 复制到 SQLite；SQLite 只保存索引、关系和状态元数据。
- 不实现浏览器、Web Search、Web Fetch、cron 或无人值守自动化。
- 不把现有 `plan.updated` 投影宣称为 durable todo writer。
- 不强制引入向量数据库、复杂协作图或第三方会话存储。
- 不在没有运行中竞态、迁移和回放证据时标记功能完成。

## 六、验收标准

1. 回退并修改、重试、Fork 三条路径都保留旧 branch/输出，并在刷新、重启后可切换和继续。
2. 运行中、非法节点、过期引用、404/409/400 等负例有稳定错误和 UI 下一步。
3. 当前 branch 的线性时间线可以点击定位并正确高亮（使用稳定 entryId/turnId 锚点，重启后不漂移）；branch switcher/tree 与线性时间线职责不混淆；分支切换结果在刷新、重启后保持。
4. Desktop 压缩完成卡可以从实时流和历史 replay 读取 summary 正文，并正确显示成功、中止、失败、no-op、busy。
5. todo 工具 → SQLite → `todo.updated` Replay → Desktop projection → reload/restart 全链路成立。
6. Todo 空列表、整表替换、非法状态、并发冲突、断线回放、多客户端一致性和失败恢复均有自动化证据。
7. Desktop 界面在长会话、窄窗口和无数据状态下不溢出、不静默失败。
8. 质量门、真实 Electron 交互、截图/trace、API/JSONL/SQLite 真值对照全部记录后，才允许将波次 B 标为已完成。

## 七、参考项目

- OpenCode：session-owned todo、whole-list replacement、SQLite 和 `todo.updated`。
- OpenHanako：SessionTodoCard、Desktop 工作区、分支/对话工作台体验。
- Codex：PlanDelta、计划状态和用户可见工作进度。
- Hermes Agent：会话压缩、后台工作可见性和辅助模型场景。
- Kimi Code Web：压缩摘要正文、时间线和 plan 的用户交互参考。

本 Feature Spec 定义产品语义；实现任务、文件边界和验证命令以英文实施计划为准。

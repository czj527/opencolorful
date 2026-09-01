# P1 波次 B：对话工作台能力

**日期：2026-08-31**  
**状态：规划中**  
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

## 三、产品语义

### 1. 回退并修改

用户在一条用户消息上选择“回退并修改”时，系统从该节点创建新 branch，打开可编辑输入并重新生成；旧 branch 保留，不覆盖旧 assistant 输出。修改后的消息属于新 branch，旧 branch 的消息不自动混入新 branch 的正文上下文。

### 2. 重试

用户在 assistant 结果上选择“重试”时，系统创建新的结果 branch，不覆盖旧输出。旧结果仍可查看和切换；重试期间同一 Session 的其他 branch 操作按运行中竞态规则处理。

### 3. Fork 独立会话

“Fork 成独立会话”创建新的 Session identity，保留来源 Session、来源 branch 和来源 entry 元数据。新会话后续可以独立归档、重命名、切换模型和继续运行。

### 4. 运行中与错误

运行中的 Session 不允许无定义地 branch/reset/fork。产品可以要求先停止运行，也可以返回稳定的 409；具体按钮交互由实现计划按本规格固定。不存在的 Session、非法 entry、过期 branch/ref 和无法恢复的 PI 操作必须返回可操作的中文错误。

### 5. 时间线与分支

右侧时间线先承担当前 branch 的线性 turn/entry 定位：点击后滚动到消息并高亮当前节点。branch tree/switcher 是另一种导航职责，显示父子关系、当前 branch 和可切换旧 branch；不把线性时间线直接变成难以扫描的复杂树。

### 6. 压缩摘要

沿用现有 `session.compacting`/`session.compacted` 事件和 payload。Desktop 完成卡显示 tokens before/after 与 summary 正文，并支持展开/折叠。压缩失败、取消、no-op、busy 都要有不同的可见状态。手动/自动 compaction 的启用策略、summary 长度上限和敏感信息处理必须先记录在实现计划和测试中；本规格不授权悄悄改变自动压缩默认值。

### 7. Session plan/todo

Todo 属于 Session，状态至少为 `pending`、`in_progress`、`completed`、`cancelled`，带 priority 和 activeForm。更新采用 whole-list replacement，写入 SQLite，事务成功后发布 `todo.updated` Replay 事件，Desktop 只消费投影。工具、存储、事件、UI 和 reload/restart 必须形成闭环；UI 不得自行伪造计划完成状态。

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
3. 当前 branch 的线性时间线可以点击定位并正确高亮；branch switcher/tree 与线性时间线职责不混淆。
4. Desktop 压缩完成卡可以从实时流和历史 replay 读取 summary 正文，并正确显示成功、取消、失败、no-op、busy。
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

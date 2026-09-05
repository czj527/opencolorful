# OpenColorful 开发流程

本文是开发流程的唯一权威文档。`AGENTS.md` 保留摘要与入口；架构硬约束见
[architecture.md](architecture.md)，编码规范见 `AGENTS.md`；文档语言政策见
[document-governance.md](document-governance.md) §8。

## 一、角色分工

| 职责 | 主 Agent | 子 Agent（团队成员） |
|---|---|---|
| 需求澄清、计划编写、任务拆分 | ✔ | |
| 并行探索、定向调研 | 可委派 | ✔ |
| 具体实现与针对性测试 | 仅 infra/文档/救火 | ✔ |
| 修改文件归属划定、冲突协调 | ✔ | |
| diff 审查、独立运行质量门 | ✔ | |
| 验收结论、提交、计划回写 | ✔ | |

铁律：

1. **子 Agent 报告不作为验收证据。** 主 Agent 必须独立检查 diff、重跑验证命令，
   处理审查发现后才能提交。
2. **子 Agent 不得扩大任务范围**、修改归属清单外的文件、自行 git 提交或宣称
   任务/阶段通过。返回必须使用第五节的报告合同。
3. **探索类子 Agent 只读不写**；实现类子 Agent 只写归属文件。
4. **主 Agent 默认不直接实现普通业务任务**（保护顶层上下文）。例外：跨任务统一
   架构判断的关键接口、子 Agent 多次失败且需要完整全局上下文、难以切分的复杂
   调试、重新派发成本明显更高的极小集成胶水。每次直接实现须在计划实施记录中
   写明原因、影响范围和验证。

## 二、并行规则

同时满足以下全部条件才允许并行派发，否则一律串行：

1. 前置接口已稳定（不存在"一任务定义接口、另一任务消费该接口"）；
2. 无共享文件（每个文件同一时刻只有一个负责人）；
3. 无共享协议/迁移/契约/schema/锁文件/路由表变更（契约先行合入，再并行实现）；
4. 无前后依赖（A 的输出不是 B 的输入；一任务失败不会让另一任务的实现假设失效）；
5. 每个任务有独立验收方法，集成顺序已明确；
6. 涉及的产品或 UI 决策已获批准（见第六节）；多个 lane 不得依赖同一个未批准决策；
7. 跨模块 bug 已定位根因（未定位根因的问题不拆分并行）。

**并行是默认目标**：主 Agent 必须先做并行性审查，把可并行任务放入同一
parallel_group 同时派发；判定串行时必须在计划中记录 `serial_reason`（具体冲突
或依赖），不得仅因管理方便串行。

派发前主 Agent 必须画出文件归属表，发现冲突时：

1. 把共享的极小公共部分（如一个 3 行方法）由主 Agent 先行实现并提交；
2. 再按剩余互不重叠的文件集合并行派发。

范例（Phase 6）：T1 契约与适配层串行先行 → T2（storage/routes/wiring）与
T3（messages 路由）文件零重叠并行 → T4（Web 用量）→ T5/T6/T7 按文件冲突
串并混合 → T8 文档由主 Agent 全程负责。

## 三、任务生命周期

1. **计划**：主 Agent 编写/更新 `plans/` 下对应计划（命名规则见 `plans/README.md`，
   结构参考附录 A）。
2. **实现**：子 Agent 按任务 Brief（第四节）实现 + 针对性测试。普通胶水代码不强制
   TDD；关键边界（Provider/Auth、Session 恢复、事件序号/Replay、Abort 竞态、
   凭据脱敏、用量幂等、跨进程输入校验）必须有失败路径覆盖。
3. **验证**：主 Agent 独立复核 diff + 重跑相关验证。
4. **提交**：每任务独立提交，提交信息使用计划中的标题；主 Agent 执行。
5. **回写**：更新计划的状态、真实提交、验证证据、已知偏差。

## 四、任务 Brief 合同

派发子 Agent 前，主 Agent 必须产出书面 brief（写在计划任务段或单独文件），
字段不全不派发：

- `role`：任务在整体计划中的作用与背景；
- `read_first`：必读文件与事实（给路径，不粘贴会话历史）；
- `owns`：允许修改的精确路径清单；
- `forbidden`：禁止触碰的范围；
- `interface`：输入/输出接口与契约引用；
- `requirements`：功能与非功能要求；
- `acceptance`：验收标准与自动化验证命令；
- `decision_mode`：本任务涉及的产品决策标注（第六节）；
- `report`：报告路径与格式（第五节）；
- `docs`：需同步更新的文档。

并行任务另附：`parallel_group` ID、lane 间文件边界、共享接口的只读引用、
集成 barrier。

## 五、子 Agent 报告合同

子 Agent 返回必须使用固定结构：

```text
状态：DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
修改文件：
关键实现：
运行命令：
验证结果（真实输出摘要）：
未验证内容：
风险与疑问：
```

没有命令、输出或可检查工件的"已完成"不予接收；`DONE_WITH_CONCERNS` 时
主 Agent 必须先处理 concerns 再集成。

## 六、产品决策标注

计划、brief 与审查中，对每个产品决策标注来源：

| 标注 | 含义 |
|---|---|
| `human-fixed` | 开发者已明确拍板，agent 不得偏离 |
| `human-selects` | 候选项已给出，等开发者选择；未选择前不实施受影响部分 |
| `agent-recommends` | agent 提出方案与理由，开发者在计划/PR 中默认批准后生效 |
| `agent-delegated` | 开发者明确授权 agent 自行决定（仅限局部实现细节） |

产品定位、差异化功能、关键交互、视觉方向默认属于 `human-fixed` /
`human-selects`；agent 未获授权不得自行决定。

## 七、风险驱动验证

不强制统一 TDD。主 Agent 在 brief 中按风险选择验证组合：

| 风险 | 推荐证据 |
|---|---|
| 纯局部计算 | 聚焦单测 |
| 回归 bug | 可失败复现 + 回归测试；必要时 test-first |
| 公共 API 或协议 | 契约测试 + 集成测试 |
| 数据与迁移 | 前向迁移、旧数据兼容、回滚/恢复演练 |
| 权限与安全 | 正向 + 负向测试、越权与输入边界 |
| UI 行为 | 组件/集成测试 + Playwright/真实桌面交互 |
| 多服务流程 | 集成环境端到端 |
| 第三方集成 | mock + 至少一个真实 smoke |

每个验收标准都必须有证据；单元测试通过不能替代真实用户路径验收。

## 八、质量红线（违反即返工）

- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 必须全过。
- 相对 import 带 `.js` 后缀；跨进程输入用 TypeBox 或显式解析器校验。
- 只有 `src/pi-sdk/` 可 import `@earendil-works/pi-*`；
  改适配层后必须跑 `node scripts/verify-pi-sdk-imports.mjs`。
- 事件先写 Replay Store 再广播；SSE/WS 共享 Replay Store；
  同 streamId sequence 从 1 严格递增。
- 验证命令逐条单独执行并读取退出码。**禁止 PowerShell 分号串联**关键验证
  （`npm run check; git status` 会掩盖前一个退出码）。
- Playwright 必须在 `web/` 目录执行 `npx playwright test`；根目录执行会错误
  收集服务端测试，不是有效验收。
- 新增 SSE 事件类型必须同步 `web/src/lib/sse-client.ts` 的
  `KNOWN_EVENT_TYPES`，否则 Web 端收不到。
- 不记录/回传/落库任何 API Key、Authorization、Cookie；错误用稳定 `ApiError`，
  文案中文且不含敏感输入。
- 手工编辑用 apply_patch；不用 `git reset --hard`、`git checkout --` 等破坏性命令；
  不回退与当前任务无关的用户改动。
- 默认测试不得请求真实 Provider 网络，不得依赖本机已有 API Key；
  用 PI faux provider + 临时 `OPENCOLORFUL_HOME`，测试结束关闭数据库/Runtime/订阅。
- 长时命令（全量 vitest）在管道中易被误判，应写结果文件后轮询读取。

## 九、质量门（验收时必须全部单独通过）

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test
npm run desktop:test
npm run desktop:build

# ===== browser-use 实际交互验收（阶段新增功能验证）=====
# 启动服务后，使用 browser-use（control-browser skill）打开 Web 工作台
# 按计划验收标准逐项操作验证用户可感知的新功能，截图留存
npm run web:build
npm run cli -- supervisor start
# → 浏览器打开 http://127.0.0.1:4311，执行功能验收，截图记录
npm run cli -- supervisor stop
```

> **browser-use 定位**：对用户可感知的新功能做真实浏览器交互验证，可作为 Playwright E2E 的补充或替代。Playwright 侧重回归防御，browser-use 侧重新功能交互验收。两者可根据阶段特性灵活侧重。

## 附录 A：阶段计划模板

```markdown
# <轨道编号>：标题

**状态：规划中/进行中/已完成（日期）** | 分支：<分支名>
**基线：** `main`（上一验收点，提交 hash）
**参考：** 调研结论与参考项目

## 一、目标        —— 用户可感知的能力，不写实现细节
## 二、能力确认    —— 依赖 SDK/现有能力的调研结论（含精确位置）
## 三~六、设计章节 —— 契约/存储/API/UI/交互，含关键 Schema 与 SQL
## 七、文件变更清单 —— 文件 | 动作 | 负责任务
## 八、任务拆分与依赖 —— 依赖图 + Task N（含验证命令、brief 字段）
## 九、质量门
## 十、验收标准    —— checkbox 清单
## 实施记录        —— 实施中回填：提交表、质量门结果、阻断与修复、最终结论
```

## 附录 B：常见陷阱

| 陷阱 | 正确做法 |
|---|---|
| PowerShell `;` 串联验证 | 逐条执行读 `$LASTEXITCODE` |
| 根目录跑 Playwright | `cd web && npx playwright test` |
| 新增事件 Web 收不到 | 同步 `sse-client.ts` 白名单 |
| SQLite 存消息正文 | JSONL 是正文唯一事实来源，SQLite 只存元数据/索引/平台状态 |
| 平台接口暴露 PI 私有类型 | 契约层定义平台类型，适配层做映射 |
| 子 Agent 报告当验收 | 主 Agent 独立复核 diff + 重跑质量门 |
| 空会话 usage 显示报错 | 无数据返回 null/空集合，UI 显示占位 |
| 并行任务改同一文件 | 立即停止相关 lane，主 Agent 重裁文件归属 |
| brief 缺字段就派发 | 字段不全不派发，先补 brief |

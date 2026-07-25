# person-Agent 开发流程

本文是开发流程的唯一权威文档。`AGENTS.md` 保留摘要与入口；架构硬约束见
[architecture.md](architecture.md)，编码规范见 `AGENTS.md`。

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
   任务/Phase 通过。返回时必须说明：修改文件清单、验证命令与真实结果、未解决问题。
3. **探索类子 Agent 只读不写**；实现类子 Agent 只写归属文件。

## 二、并行规则

同时满足以下全部条件才允许并行派发，否则一律串行：

- 无共享文件（每个文件同一时刻只有一个负责人）；
- 无共享协议/迁移/契约变更（契约先行合入，再并行实现）；
- 无前后依赖（A 的输出不是 B 的输入）。

派发前主 Agent 必须画出文件归属表，发现冲突时：

1. 把共享的极小公共部分（如一个 3 行方法）由主 Agent 先行实现并提交；
2. 再按剩余互不重叠的文件集合并行派发。

范例（Phase 6）：T1 契约与适配层串行先行 → T2（storage/routes/wiring）与
T3（messages 路由）文件零重叠并行 → T4（Web 用量）→ T5/T6/T7 按文件冲突
串并混合 → T8 文档由主 Agent 全程负责。

## 三、任务生命周期

1. **计划**：主 Agent 编写/更新 `plans/phase-xx.md`（模板见附录 A）。
2. **RED**：关键边界先写最小失败测试并确认失败（编译失败或断言失败均可算
   RED，但必须亲眼看到失败输出）。关键边界清单：
   - Provider/Auth、Session 恢复、事件序号与 Replay、Abort 竞态、WS 权限、
     A2UI/TokUI 安全、凭据脱敏、用量落库幂等、跨进程输入校验。
3. **实现**：子 Agent 按归属实现，普通胶水代码不强制完整 TDD，但必须通过
   严格类型检查与相关测试。
4. **任务级验证**：先跑任务指定测试，再单独运行 `npx tsc --noEmit -p tsconfig.json`。
5. **审查**：主 Agent 独立看 diff、重跑验证。
6. **提交**：每任务独立提交，提交信息使用计划中的标题；主 Agent 执行。
7. **回写**：更新 `plans/phase-xx.md` 的状态、真实提交、验证证据、已知偏差。
8. **验收**：Phase 全部完成且质量门通过后，更新主文档、打标签
   `phase-x-complete`、请求合并 `main`。

## 四、质量红线（违反即返工）

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
  用 PI faux provider + 临时 `PERSON_AGENT_HOME`，测试结束关闭数据库/Runtime/订阅。
- 长时命令（全量 vitest）在管道中易被误判，应写结果文件后轮询读取。

## 五、质量门（验收时必须全部单独通过）

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test
```

## 附录 A：Phase 计划模板

```markdown
# Phase N：标题

**状态：规划中/进行中/已完成（日期）** | 分支：`phase-n-xxx`
**基线：** `main`（上一 Phase 验收点，提交 hash）
**参考：** 调研结论与参考项目

## 一、目标        —— 用户可感知的能力，不写实现细节
## 二、能力确认    —— 依赖 SDK/现有能力的调研结论（含精确位置）
## 三~六、设计章节 —— 契约/存储/API/UI/交互，含关键 Schema 与 SQL
## 七、文件变更清单 —— 文件 | 动作 | 负责任务
## 八、任务拆分与依赖 —— 依赖图 + Task N（含验证命令）
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

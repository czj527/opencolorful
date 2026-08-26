# G1：仓库收敛与 Desktop 优先

**状态：已完成（2026-08-26）** | 基线：`main`（`fa6da19`）| 类型：治理轨道（纯文档与流程，无生产代码变更）
**上游：** `docs/positioning-and-roadmap.md` §五；**关联：** `plans/desktop-parity.md`、`docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`

## 一、背景与决策来源

2026-08-26 与项目作者对齐的三条决策：

1. **项目以 desktop 端为主**；
2. **长期单人开发**，不考虑多人协作；
3. **CI/CD 与文档治理的目的是约束 AI 开发 agent**——强制 agent 同步文档、规范流程、保持项目对作者可接续，而不是多人协作门禁。

起因诊断：平台底座（Phase 0-14）完成后，仓库复杂度已超出单人可跟踪范围——19 份 plans、15+ 份 docs、三套并存编号（Phase/G/P + desktop-parity 内部 P 波次）、两套前端、11 步质量门。对比同技术栈、同为单人项目的 openhanako，差距集中在**产品端**（桌面完成度、上手路径、助理存在感、发布工程），不在平台端。继续扩张平台抽象只会加大失控。

## 二、决策

### G1.1 前端收敛：desktop 是唯一产品前端

- `desktop/` 是产品端，承接所有面向用户的新功能；
- `web/` **冻结新功能开发**，定位降级为"浏览器运维、测试与协议验收客户端"（`docs/infrastructure-decisions.md` §八已有此定位，本计划坐实）；现有页面保留，Playwright E2E 基座继续作为质量门运行；
- `plans/desktop-parity.md` 的剩余波次**并入 P1 产品轨道**执行，它就是 P1 的桌面补齐主干，不再作为独立轨道；
- 两侧的数据源/投影抽象（desktop `data/projector` 与 web `sse-client`）**暂不抽共享包**，待 P1 切片 1 验收时用真实重复度评估。

### G1.2 编号去冲突

desktop-parity 内部波次由 P0-P7 改名 **D0-D7**。全仓库只保留两套活跃编号：产品路线 P1-P3、治理轨道 G0/G1。历史 Phase 编号永久封存。

### G1.3 文档减负

- `AGENTS.md` 只保留入口、硬约束和质量门；"当前开发状态"长段收编为指向 `docs/project-status.md` 的摘要（落实 `docs/document-governance.md` §1 单一事实源）；
- `plans/phase-00~14.md` 维持"已归档"，不再出现在 AGENTS.md 的活动导航中；文件保留为历史证据；
- 新增文档必须先声明唯一权威归属，再走导航链接（治理 §7 既有规则，重申执行）。

### G1.4 治理重定位：单人 + AI agent 护栏

- `docs/document-governance.md` 增补定位段，明确规则服务对象是"单人作者 + AI 开发 agent"；
- 分支保护、三 job CI、PR 流程**保持不变**，对作者与 agent 一体适用（所有变更走 PR，不直推 main）；
- 质量门**不减少**；允许本地迭代使用增量检查，提交 PR 前必须全量 `npm run check`。

### G1.5 平台冻结纪律

P1 完成前不开新的平台层抽象（新契约面、新投影层、新存储层、新进程），除非它直接承载当前切片内的用户可见功能。Phase 15+ 多 Agent 团队、Bridge、DAG 编排、Cordis 化继续冻结（roadmap R1，远期研究）。

## 三、任务清单（本计划在一个 PR 内完成）

| 任务 | 文件 | 动作 |
|---|---|---|
| T1 | `plans/g1-repo-convergence.md` | 新建（本文件） |
| T2 | `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md` | 新建 P1 切片 1 规格 |
| T3 | `docs/positioning-and-roadmap.md` | G0 收口、新增 G1 段、P1 链接 spec |
| T4 | `docs/project-status.md` | G0 已完成、G1 进行中、P1 状态更新 |
| T5 | `AGENTS.md` | 状态段瘦身、导航表更新、参考仓库数修正 |
| T6 | `docs/document-governance.md` | 增补 §0 定位段 |
| T7 | `plans/README.md` | 轨道计划命名规则 |
| T8 | `plans/desktop-parity.md` | 波次改 D 编号、并入 P1 说明 |

## 四、非目标

- 不删除或重写任何历史 phase 计划内容；
- 不改动 CI workflow、分支保护和质量门命令；
- 不统一 `docs/development.md` 与 AGENTS.md 简化版的流程描述差异（已知偏差，留待 P1 实施计划启动时一并处理）；
- 不动 `web/`、`desktop/`、`src/` 任何代码。

## 五、验收标准

- `npm run check:docs` 通过，Governance CI 绿；
- 仓库活跃文档中不再存在第二套 P 编号（desktop-parity 波次已改 D）；
- `docs/project-status.md` 准确反映 G0 完成、G1 进行中、P1 切片 1 已立项；
- AGENTS.md 活动导航中不再逐条罗列历史 phase。

## 实施记录

2026-08-26：T1-T8 全部落地于 PR #11（squash 合并 `d085d28`）；状态收口于后续单文档 PR。验证：`npm run check:docs` 通过（8 个变更文件全部合规）；PR #11 CI run 32949866672 三 job 全绿（Governance 6s / Browser E2E 2m13s / Typecheck, tests and builds 5m1s）。验收标准四项全部满足：活跃文档无第二套 P 编号、project-status 反映真实状态、AGENTS.md 活动导航不再逐条罗列历史 phase、治理定位段落生效。

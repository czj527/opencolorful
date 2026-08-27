# OpenColorful 当前项目状态

**更新时间：2026-08-27**
**当前基线：** `main`  `70926e2`
**状态维护规则：** 本文件只记录当前状态；历史平台实施细节归 `plans/`，产品路线归 `positioning-and-roadmap.md`。当前仓库治理使用 G 编号，产品路线使用 P/R 编号，桌面补齐波次使用 D 编号；历史 Phase 编号永久封存。

## 当前结论

- Phase 0-14 已完成并合入 `main`，实施证据保留在 `plans/phase-00.md` 至 `plans/phase-14.md`，全部为已归档历史，不作为当前待办。
- **G0 仓库治理已完成（2026-08-26）**：GitHub Actions 三 job（Governance / Quality / Browser E2E）全绿，分支保护生效（必须 PR、三检查必过、禁 force push），Dependabot 存量清零。修复台账见 `plans/g0-ci-linux-fixes.md`。
- **G1 仓库收敛与 Desktop 优先已完成（2026-08-26）**：desktop 为唯一产品前端，web 冻结为运维/测试面；治理规则重定位为单人 + AI agent 护栏；编号去冲突与文档减负落地。见 `plans/g1-repo-convergence.md`。
- **P1 切片 1 实现已全部合并（2026-08-27，PR #16-#23）**：onboarding 四步向导、原生目录选择器、助理身份证卡与侧栏分组、高级新建会话表单、档案页与记忆日用写操作（含 pinned 写端点）、错误恢复文案。规格见 `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`；各任务实施记录见 `plans/p1-t1~t6-*.md` 与各 PR 描述（`plans/p1-t3-session-form.md` 含 workspaceConfirmed 安全修正记录）。**待作者真实后端验收**：验收用例 I1-I14 见 `plans/desktop-e2e-test-plan.md` 波次七（需真实 API Key），规格验收核心为作者真实日用 ≥5 天。已知非阻塞偏差：T6 无模型拦截在模型列表未加载完的瞬间有误中窗口；T5 档案页错误提示未走 errors.ts 集中映射。
- 主分支必须保持可安装、可构建、可测试；所有变更走 PR，不直推 `main`。

## 阶段状态

| 阶段 | 主题 | 状态 | 权威记录 |
|---|---|---|---|
| Governance G0 | CI/CD 和公开协作 | 已完成（2026-08-26） | `plans/g0-ci-linux-fixes.md`、`docs/ci-cd.md`、`docs/document-governance.md` |
| Governance G1 | 仓库收敛与 Desktop 优先 | 已完成（2026-08-26） | `plans/g1-repo-convergence.md` |
| Product P1 | 个人助理基础体验 | 进行中（切片 1 代码已合并，待真实后端验收） | `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`、`plans/desktop-parity.md`、`plans/p1-t1~t6-*.md` |
| Product P2 | 个人效率工作台 | 未排期 | `docs/positioning-and-roadmap.md` |
| Product P3 | 扩展生态与连接能力 | 未排期 | `docs/positioning-and-roadmap.md` |
| Research R1 | Cordis 化与远期自进化 | 远期研究 | `docs/positioning-and-roadmap.md` |

## 当前优先级

1. P1 切片 1 真实后端验收：作者执行 `plans/desktop-e2e-test-plan.md` 波次七 I1-I14 用例（需真实 API Key），并真实日用 ≥5 天；验收中发现的问题走缺陷修复 PR。
2. 冻结平台扩张：不新增平台层抽象，Phase 15+、Bridge、DAG、Cordis 化继续冻结（G1.5）。
3. 保持 `main` 在干净环境可复现安装、类型检查、测试、Web 构建和 Desktop 构建。

## 状态更新规则

- 阶段或治理轨道开始：更新本文件、路线图和对应 Feature Spec/计划的状态。
- 阶段进行中：实时任务写在计划的实施记录中，不把每个小任务复制到本文件。
- 阶段完成：写入真实提交、质量门结果、浏览器验收和已知偏差，再更新本文件。
- 阶段取消或改向：保留原计划和原因，在本文件记录新的决策链接。

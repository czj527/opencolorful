# OpenColorful 当前项目状态

**更新时间：2026-08-28**
**当前基线：** `main`  `1aadf6e`
**状态维护规则：** 本文件只记录当前状态；历史平台实施细节归 `plans/`，产品路线归 `positioning-and-roadmap.md`。当前仓库治理使用 G 编号，产品路线使用 P/R 编号，桌面补齐波次使用 D 编号；历史 Phase 编号永久封存。

## 当前结论

- Phase 0-14 已完成并合入 `main`，实施证据保留在 `plans/phase-00.md` 至 `plans/phase-14.md`，全部为已归档历史，不作为当前待办。
- **G0 仓库治理已完成（2026-08-26）**：GitHub Actions 三 job（Governance / Quality / Browser E2E）全绿，分支保护生效（必须 PR、三检查必过、禁 force push），Dependabot 存量清零。修复台账见 `plans/g0-ci-linux-fixes.md`。
- **G1 仓库收敛与 Desktop 优先已完成（2026-08-26）**：desktop 为唯一产品前端，web 冻结为运维/测试面；治理规则重定位为单人 + AI agent 护栏；编号去冲突与文档减负落地。见 `plans/g1-repo-convergence.md`。
- **P1 切片 1 实现已全部合并（2026-08-27，PR #16-#23）**：onboarding 四步向导、原生目录选择器、助理身份证卡与侧栏分组、高级新建会话表单、档案页与记忆日用写操作（含 pinned 写端点）、错误恢复文案。规格见 `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`；各任务实施记录见 `plans/p1-t1~t6-*.md` 与各 PR 描述（`plans/p1-t3-session-form.md` 含 workspaceConfirmed 安全修正记录）。已知非阻塞偏差：T6 无模型拦截在模型列表未加载完的瞬间有误中窗口；T5 档案页错误提示未走 errors.ts 集中映射。
- **P1 切片 1.5 可用性攻坚已全部合并（2026-08-28，PR #26-#29）**：T11 `supervisor start` 自动拉起 agent server；T7 SSE 渲染性能四件套（合批节流 + projector O(1) + memo + 状态下沉）；T9 会话中心 IA（去全局助理、会话行 badge、会话头 chip、空态身份证卡、新建助理入口、档案页人设编辑、mock 横幅）；T8 设置页四类目全接线（外观/模型与 Provider 含默认模型/对话显示/关于，删除 8 个死类目）。规格 `docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`，lane log 见 `plans/p1-t7/t8/t9/t11-*.md`。**待作者执行波次八验收**：I 组回归（I7 按会话中心 IA 改写）+ 切片 1.5 验证项（流畅度/零死控件/IA 自洽/环境坑消除），通过后继续 5 天日用。
- **P1 切片 1.75 记忆激活已全部合并（2026-08-28，PR #31-#33）**：T12 记忆使用规则四条契约（openhanako 模式，规则段移出注入预算）；T13 五工具 WHEN/SKIP 引导（hermes schema 模式）；T14 后台复盘服务（每轮 turn.completed 一次 utility LLM 调用 → journal 意图 actor=background_review，审批仍归记忆 Agent；`reviewEnabled` 设置 + 档案页开关；schema v13 迁移）；T15 行为级闭环测试（复盘意图→审批→search_memory 召回全链路，逐步断言中间态）。规格 `docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`，lane log 见 `plans/p1-t12-t13/t14/t15-*.md`。**待作者真实日用观察** remember/复盘触发率与记忆质量，作为切片 2 记忆方向（衰减/有效性窗口/复盘意图强度分档）立项依据。
- 主分支必须保持可安装、可构建、可测试；所有变更走 PR，不直推 `main`。
- **G2 桌面发布分发与版本更新（2026-08-28 热修收口）**：T1 打包管线与内嵌后端、T2 应用内版本更新、T3 release workflow（PR #35-#38）。**v0.1.0 为不可用版本**——asar 缺 workspace 插件包导致安装版后端启动即崩，叠加 4310 端口被占时代理误连外来进程、draft 资产不完整两缺陷；热修（staging `file:` 依赖实拷 + `verify:pack` asar 断言 + probe 身份校验 + EADDRINUSE 随机端口回退 + 发布资产断言兜底，事故三教训见 `plans/g2-desktop-release.md` T4）后首个有效发布为 **v0.1.1**。

## 阶段状态

| 阶段 | 主题 | 状态 | 权威记录 |
|---|---|---|---|
| Governance G0 | CI/CD 和公开协作 | 已完成（2026-08-26） | `plans/g0-ci-linux-fixes.md`、`docs/ci-cd.md`、`docs/document-governance.md` |
| Governance G1 | 仓库收敛与 Desktop 优先 | 已完成（2026-08-26） | `plans/g1-repo-convergence.md` |
| Governance G2 | 桌面发布分发与版本更新 | 热修已合并；v0.1.0 不可用，待作者切 v0.1.1 tag 验收 | `plans/g2-desktop-release.md` |
| Product P1 | 个人助理基础体验 | 进行中（切片 1/1.5/1.75 代码已合并，待作者波次八验收+真实日用观察） | `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`、`docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`、`docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`、`plans/desktop-parity.md`、`plans/p1-t1~t15-*.md` |
| Product P2 | 个人效率工作台 | 未排期 | `docs/positioning-and-roadmap.md` |
| Product P3 | 扩展生态与连接能力 | 未排期 | `docs/positioning-and-roadmap.md` |
| Research R1 | Cordis 化与远期自进化 | 远期研究 | `docs/positioning-and-roadmap.md` |

## 当前优先级

1. **P1 真实日用与波次八验收（均待作者执行）**：切片 1.5（PR #26-#29）与切片 1.75（PR #31-#33）已全部合并。作者按 `plans/desktop-e2e-test-plan.md` 执行波次八（I 组回归 + 切片 1.5 验证项），并在真实日用中观察记忆触发率与质量（切片 1.75 验证项）。
2. **G2 待作者切 v0.1.1 发布 tag**：热修已合并；v0.1.0 tag/draft 由作者清理后，按 `docs/release.md` 发布操作执行（含发布前"仓库外启动冒烟"新门槛），并顺带验证 v0.1.0→v0.1.1 更新链路。
3. 冻结平台扩张：不新增平台层抽象，Phase 15+、Bridge、DAG、Cordis 化继续冻结（G1.5）。
4. 保持 `main` 在干净环境可复现安装、类型检查、测试、Web 构建和 Desktop 构建。

## 状态更新规则

- 阶段或治理轨道开始：更新本文件、路线图和对应 Feature Spec/计划的状态。
- 阶段进行中：实时任务写在计划的实施记录中，不把每个小任务复制到本文件。
- 阶段完成：写入真实提交、质量门结果、浏览器验收和已知偏差，再更新本文件。
- 阶段取消或改向：保留原计划和原因，在本文件记录新的决策链接。

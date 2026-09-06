# OpenColorful 当前项目状态

**更新时间：2026-09-06**
**当前基线：** `main`  `c82c4d2`（波次 B 收尾、独立质量评估报告、架构图谱与审计立即修复批次 #63-#66/#69 全部合并——5 项立即修复全部完成）
**状态维护规则：** 本文件只记录当前状态；历史平台实施细节归 `plans/`，产品路线归 `positioning-and-roadmap.md`。当前仓库治理使用 G 编号，产品路线使用 P/R 编号，桌面补齐波次使用 D 编号；历史 Phase 编号永久封存。

**开发者工作台：** [项目看板与架构地图](architecture-map/index.html) 提供当前状态的日常排序、
验收清单和架构跳转。看板是本文件、阶段计划和独立质量评估的开发者投影，不取代这些事实来源。

## 当前结论

- Phase 0-14 已完成并合入 `main`，实施证据保留在 `plans/phase-00.md` 至 `plans/phase-14.md`，全部为已归档历史，不作为当前待办。
- **G0 仓库治理已完成（2026-08-26）**：GitHub Actions 三 job（Governance / Quality / Browser E2E）全绿，分支保护生效（必须 PR、三检查必过、禁 force push），Dependabot 存量清零。修复台账见 `plans/g0-ci-linux-fixes.md`。
- **G1 仓库收敛与 Desktop 优先已完成（2026-08-26）**：desktop 为唯一产品前端，web 冻结为运维/测试面；治理规则重定位为单人 + AI agent 护栏；编号去冲突与文档减负落地。见 `plans/g1-repo-convergence.md`。
- **P1 切片 1 实现已全部合并（2026-08-27，PR #16-#23）**：onboarding 四步向导、原生目录选择器、助理身份证卡与侧栏分组、高级新建会话表单、档案页与记忆日用写操作（含 pinned 写端点）、错误恢复文案。规格见 `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`；各任务实施记录见 `plans/p1-t1~t6-*.md` 与各 PR 描述（`plans/p1-t3-session-form.md` 含 workspaceConfirmed 安全修正记录）。已知非阻塞偏差：T6 无模型拦截在模型列表未加载完的瞬间有误中窗口；T5 档案页错误提示未走 errors.ts 集中映射。
- **P1 切片 1.5 可用性攻坚已全部合并（2026-08-28，PR #26-#29）**：T11 `supervisor start` 自动拉起 agent server；T7 SSE 渲染性能四件套（合批节流 + projector O(1) + memo + 状态下沉）；T9 会话中心 IA（去全局助理、会话行 badge、会话头 chip、空态身份证卡、新建助理入口、档案页人设编辑、mock 横幅）；T8 设置页四类目全接线（外观/模型与 Provider 含默认模型/对话显示/关于，删除 8 个死类目）。规格 `docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`，lane log 见 `plans/p1-t7/t8/t9/t11-*.md`。**待作者执行波次八验收**：I 组回归（I7 按会话中心 IA 改写）+ 切片 1.5 验证项（流畅度/零死控件/IA 自洽/环境坑消除），通过后继续 5 天日用。
- **P1 切片 1.75 记忆激活已全部合并（2026-08-28，PR #31-#33）**：T12 记忆使用规则四条契约（openhanako 模式，规则段移出注入预算）；T13 五工具 WHEN/SKIP 引导（hermes schema 模式）；T14 后台复盘服务（每轮 turn.completed 一次 utility LLM 调用 → journal 意图 actor=background_review，审批仍归记忆 Agent；`reviewEnabled` 设置 + 档案页开关；schema v13 迁移）；T15 行为级闭环测试（复盘意图→审批→search_memory 召回全链路，逐步断言中间态）。规格 `docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`，lane log 见 `plans/p1-t12-t13/t14/t15-*.md`。**待作者真实日用观察** remember/复盘触发率与记忆质量，作为切片 2 记忆方向（衰减/有效性窗口/复盘意图强度分档）立项依据。
- 主分支必须保持可安装、可构建、可测试；所有变更走 PR，不直推 `main`。
- **G2 桌面发布分发与版本更新（2026-08-28 热修收口）**：T1 打包管线与内嵌后端、T2 应用内版本更新、T3 release workflow（PR #35-#38）。**v0.1.0 为不可用版本**——asar 缺 workspace 插件包导致安装版后端启动即崩，叠加 4310 端口被占时代理误连外来进程、draft 资产不完整两缺陷；热修（staging `file:` 依赖实拷 + `verify:pack` asar 断言 + probe 身份校验 + EADDRINUSE 随机端口回退 + 发布资产断言兜底，事故三教训见 `plans/g2-desktop-release.md` T4）后，`v0.1.1` tag 已存在且指向 `3ae674d`，但对应 GitHub Release 仍为 Draft，不能描述为正式发布。
- **2026-09-06 独立交付质量评估**：A/B 代码均已合并，但当前不标记产品完成。已复现 P0 本机 HTTP/WS 信任边界不足、P0 v13/v14 迁移中断不可恢复；B3 分支真链重复运行 1/3 通过。Plugin import 检查是假通过；B4/B5 Electron 真链、安装/更新/恢复和人工体验仍待完成。完整报告见 `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md`。
- **2026-09-06 审计立即修复批次（5/5 全部完成：#63-#66、#69）**：#63 `verify-plugin-imports` 从"恒 exit 0 假门"（入口比较路径与 URL 恒不相等）修复为真实扫描并新增执行性回归；#64 v13/v14 表重建迁移事务化 + 临时表自清理 + 故障注入回归，升级中断后下次启动自恢复；#65 Agent 设置读取失败 fail-closed，不再静默降级为无沙箱运行；#66 本机 HTTP/WS 信任边界——启动令牌（env/文件/随机生成，`timingSafeEqual` 比较）、全局 Host/Origin/JSON Content-Type 校验、WS 握手来源校验，desktop/TUI/CLI 已接线，无 fail-open 测试开关；#69 B3 间歇性发送禁用根因修复（见下条）。架构图谱与开发者看板随 #67 入库（`architecture:check` 接入质量门；过程中暴露的"PR 合并树基线导致生成物判定过期"属门禁正确行为，跨平台排序不确定性已修复）。批次期间 CI 唯一失败为 #66 首版与 #65 回归测试的令牌交互（真实语义冲突），评审修复后转绿；`detect-path-bins` 维持既有已知偶发记录，本批次无新增抖动实证。
- **2026-09-06 全量 desktop 真链套件本地复跑（#66 连带问题首次暴露）**：27 例 = 9 过 / 18 败；b3 lane 3/3 全过（含修复后的 BRANCH-03/04），a5 通过；**a4a/a4b/a4c/a4d/a4e 五个 lane 的 fixture 在 setup 阶段被 #66 信任边界 403 拒绝**（18 例中 12 例错误直接为 Node 侧写请求 `HTTP 403`，如"配置 stub Provider 应成功：HTTP 403"）——与 lane-b3 当时被挡完全同因，lane-b3 已在 #69 适配，其余五个 lane 未适配。CI 只跑 `@smoke` 覆盖不到全量 lane，故 #66-#69 的 CI 均未发现。**新增后续修复首项：五个 a4 lane fixture 令牌适配后全量真链复跑须 27/27**；在此之前"真链 26/27→27/27"与审计 AUTO_PASS 缺口不能宣称闭合。
- **2026-09-06 B3 分支真链间歇性发送禁用——根因修复完成（#69）**：trace 实证为**测试时序缺陷**而非分支功能缺陷——`expectIdle` 在首轮 `createThread/updateModel/updateSettings` 的 API 阶段假通过（streaming 从未翻转），随后 `setThreadId` 触发空态↔会话态 Composer 换挂（同名可访问文本框），第二条基线消息的原子 fill 落在被卸载节点（失败 trace 中第二问文本仅存在于动作参数、从未进入任何 DOM 快照）。修复为两处基线 `expectIdle` 后等待当轮用户气泡；lane-b3 fixture 同步适配 #66 信任边界令牌（承接平台故障子代理的已提交工作，评审保留）。验证：同载荷加压 8 轮 0 次签名复现（6 过 + 2 次极端人工负载下的 fixture 拆卸 EBUSY 噪声，属另一层既有问题已记录）、lane-b3 全文件 3/3、desktop 双 tsc + vite 构建通过。产品侧"创建过渡期继续打字丢焦点"作为轻微 UX 现象记录于实施记录，不构成功能缺陷。

## 阶段状态

| 阶段 | 主题 | 状态 | 权威记录 |
|---|---|---|---|
| Governance G0 | CI/CD 和公开协作 | 已完成（2026-08-26） | `plans/g0-ci-linux-fixes.md`、`docs/ci-cd.md`、`docs/document-governance.md` |
| Governance G1 | 仓库收敛与 Desktop 优先 | 已完成（2026-08-26） | `plans/g1-repo-convergence.md` |
| Governance G2 | 桌面发布分发与版本更新 | 热修已合并；`v0.1.1` tag 已存在但 GitHub Release 仍为 Draft，待正式发布与安装/更新实测 | `plans/g2-desktop-release.md` |
| Product P1 | 个人助理基础体验 | 进行中（切片 1/1.5/1.75 代码已合并；波次八、发布实测和后续规划待收口） | `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`、`docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`、`docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`、`plans/desktop-parity.md`、`plans/p1-t1~t15-*.md` |
| Product P1 内部波次 A | 质量体系、两档模型与统一用量 | **工程实现已合并；独立质量评估未通过**（2026-09-06）：A0-A9 已合并（PR #40-#54），常规类型检查、根测试、Web、Desktop Mock/构建和 Web Playwright 通过；但 Plugin import 检查是假通过，v13/v14 迁移中断恢复失败，人工验收和发布验证未完成。状态：`HUMAN_PENDING`、`RELEASE_PENDING`。 | `docs/superpowers/specs/2026-08-31-p1-quality-model-usage.md`、`plans/p1-quality-model-usage.en.md`、`docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` |
| Product P1 内部波次 B | 对话工作台能力 | **工程实现基本完成；独立质量评估未通过**（2026-09-06）：B0-B5b 已合并（PR #55-#61，B6/B7 收尾记录在 #62）。Web Playwright 60/60、Desktop 单测 102/102、B 聚焦测试 52/52；Desktop 真链 26/27，B3 `BRANCH-03/04` 重复 3 次仅 1 次通过；B4/B5 Electron 真链、人工验收和发布验证未完成。状态：`HUMAN_PENDING`、`RELEASE_PENDING`。 | `docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md`、`plans/p1-conversation-workbench.en.md`、`docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` |
| Product P1 独立专项 | 浏览器能力与安全边界 | 规划中（独立于波次 B，尚未实施） | `docs/superpowers/specs/2026-08-31-browser-capability.md`、`plans/browser-capability.en.md` |
| Product P2 | 个人效率工作台 | 未排期 | `docs/positioning-and-roadmap.md` |
| Product P3 | 扩展生态与连接能力 | 未排期 | `docs/positioning-and-roadmap.md` |
| Research R1 | Cordis 化与远期自进化 | 远期研究 | `docs/positioning-and-roadmap.md` |

## 当前优先级

1. **a4 lane fixture 令牌适配（#66 连带收口，新增首项）**：lane-a4a/a4b/a4c/a4d/a4e 五个 fixture 按 #69 lane-b3 同法适配信任边界令牌，全量真链复跑须 27/27；其后按审计报告 §10"后续修复"队列推进（runtime single-flight、usage durable spool、Fork JSONL/SQLite 对账、Desktop 设置失败回滚、分支请求 generation/token、SSE 合批去重、B4/B5 Electron 真链、web `todo.updated`/branch 事件收口、Desktop secondary 模型入口、Mock 入口隐藏或标注），并补齐审计报告 §8 人工验收卡执行。A/B 产品完成状态在人工与发布验收前不翻转。
2. **补齐波次 B 真链与人工验收**：补 compact/todo Electron 真链，执行独立报告中的 A/B 人工验收卡，确认错误、恢复、长期使用和用户可理解性。
3. **G2 发布事实单独收口**：清理重复 Draft Release，完成仓库外安装启动、更新、重启安装、数据恢复和发布资产验证；不能以 tag 或 CI 绿替代。
4. **浏览器作为独立专项后续实施**：先做安全契约和威胁模型，再做只读 Inspect、Desktop 右侧 Browser Panel、受控动作和人工元素选取，最后才评估 Agent/Plan/Cron 接线。规划见 `docs/superpowers/specs/2026-08-31-browser-capability.md` 与 `plans/browser-capability.en.md`；不与波次 B 混做。
5. **五天真实日用后置**：在安全、迁移、B3 稳定性、Desktop 真实交互和有效发布/安装链路完成前，不把五天体验作为下一步唯一任务。

## 状态更新规则

- 阶段或治理轨道开始：更新本文件、路线图和对应 Feature Spec/计划的状态。
- 阶段进行中：实时任务写在计划的实施记录中，不把每个小任务复制到本文件。
- 阶段完成：写入真实提交、质量门结果、浏览器验收和已知偏差，再更新本文件。
- 阶段取消或改向：保留原计划和原因，在本文件记录新的决策链接。
- 独立质量评估必须把代码合并、自动化通过、人工体验和发布验证分开记录；发现阻断项时，历史实施记录不回写为“未发生”，而是在当前状态和独立报告中明确覆盖。

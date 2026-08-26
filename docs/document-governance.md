# OpenColorful 文档治理

本文是仓库文档的治理规则。它不替代 `AGENTS.md`，而是规定不同文档之间的分工、生命周期和自动检查方式。

## 0. 定位：单人 + AI agent 开发的护栏

本套规则的服务对象是**单人作者 + AI 开发 agent** 的开发模式（2026-08-26 明确，见 `plans/g1-repo-convergence.md`），不是多人协作门禁。它解决三个问题：

- **强制留痕**：AI agent 的每次变更必须同步文档，设计与状态证据可审计（§3、§4）；
- **可接续性**：作者与后续接手的 agent 随时能通过少量权威文档重新掌握项目全貌，而不必考古全部历史；
- **约束改动半径**：变更影响矩阵限制单次变更的波及面，防止复杂度在无人察觉时膨胀。

分支保护与 CI 门禁对作者和 agent 一体适用：所有变更走 PR，不直推 `main`；治理文件自身的修改也必须通过同一套 CI（§7）。

## 1. 单一事实源

同一事实只维护一个权威位置，其他文档通过链接引用：

| 事实 | 权威文件 | 其他文件的职责 |
|---|---|---|
| 产品定位和长期路线 | `docs/positioning-and-roadmap.md` | `README.md` 只保留公开摘要 |
| 当前阶段和基线 | `docs/project-status.md` | `AGENTS.md` 只提供入口 |
| 全局 agent 工作规则 | `AGENTS.md` | `CLAUDE.md` 只做兼容入口 |
| 技术架构和不变量 | `docs/architecture.md` 及专题架构文档 | 计划只引用，不复制长期规则 |
| 开发、测试和验收流程 | `docs/development.md` | `AGENTS.md` 保留摘要 |
| 阶段实施步骤 | `plans/phase-xx.md` | Issue 记录实时状态 |
| 单个功能规格 | `docs/superpowers/specs/` 或 `specs/` | 计划记录落地步骤 |
| 用户可见变化 | `CHANGELOG.md` | 代码注释不替代发布说明 |

## 2. 文档类型和生命周期

```text
路线图 -> Feature Spec -> Phase Plan -> 实施记录 -> Changelog
                         \-> ADR / 架构文档（长期决策）
```

- **路线图**：只写阶段、优先级和方向，不写实现细节。
- **Feature Spec**：写用户问题、目标、非目标、约束和验收标准。
- **Phase Plan**：写任务、文件归属、依赖、测试、迁移和退出条件。
- **ADR / 架构文档**：写影响未来设计的决定、替代方案和后果；只新增或明确 supersede，不篡改历史理由。
- **实施记录**：写真实提交、验证命令、阻断和偏差；完成后保留为历史证据。
- **Changelog**：只写用户或集成方能感知的变化，不当作内部 Todo。

## 3. 代码变更的文档收口

每次生产代码变更必须在以下至少一处留下可追踪的设计或状态证据：

- 当前阶段的 `plans/phase-xx.md`；
- 相关 Feature Spec；
- `docs/` 专题文档；
- ADR / 实施记录；
- 用户可见变化则补 `CHANGELOG.md`。

纯测试、格式化、依赖锁文件刷新和明确标注的纯重构可以申请 `docs-exempt`，但必须在 PR 描述中写原因。CI 会拒绝空的例外标记。

## 4. 变更影响矩阵

机器可读规则在 [`change-impact.json`](change-impact.json)。提交前和 PR CI 都会根据 diff 分类：

| 表面 | 典型路径 | 除代码外至少检查 |
|---|---|---|
| Runtime / 契约 | `src/runtime/`、`src/contracts/`、`src/server/` | 架构、计划或 ADR；类型/契约测试 |
| 持久化 | `src/storage/`、migration、JSONL/SQLite 代码 | 数据模型、迁移/恢复说明；迁移测试 |
| Agent 行为 | `src/pi-sdk/`、Agent/Plugin/Skill/Subagent 代码 | 生命周期/权限/架构文档；snapshot 或集成测试 |
| Web / Desktop | `web/`、`desktop/`（各自 `package.json` 除外，归发布/生成物） | 设计或计划；组件测试和 Browser E2E |
| 安全 | sandbox、auth、credentials、policy、审计代码 | `SECURITY.md` 或专题安全文档；负例测试 |
| 发布 / 生成物 | `package.json`（含 `web/`、`desktop/` 的）、脚本、生成目录、CI | 开发/发布文档；干净安装和构建 |

## 5. CI 门禁

GitHub Actions 分为三层：

1. **Governance**：检查变更是否按矩阵维护了文档，检查治理文件和计划状态的基本完整性。
2. **Quality**：在 Node 22.19 的干净环境运行 `npm ci --legacy-peer-deps` 和 `npm run check`。
3. **Browser**：安装 Chromium 后从 `web/` 运行 Playwright E2E。

分支保护应把 Governance、Quality 和 Browser 三个 job 都设为 required status checks；未经检查通过，不允许合并到 `main`。

## 6. 例外机制

PR 描述中使用：

```text
docs-exempt: <具体原因>
```

只允许用于纯测试、文档自身变更、脚本维护或不改变行为的机械更新。PR 检查中的例外理由只能来自 PR 标题/正文或本地 DOCS_EXEMPT_REASON 环境变量；合并后的 push 检查会额外读取显式的 head-commit 标记，以复现已经批准的例外。

治理脚本会拒绝在源码、跨进程契约、持久化、Agent/Plugin/Skill/Subagent、Web/Desktop、包配置等行为表面变更上使用例外。涉及公共 API、权限、凭据、审计或用户可见 UI 的变更必须补充对应文档收口。

## 7. 维护规则

- 新增一类事实时，先决定它的唯一权威文件，再加导航链接和影响矩阵规则。
- 发现两份文档描述同一事实时，保留一份权威内容，另一份改为链接或历史说明。
- 计划完成后更新 `docs/project-status.md`，不要只在计划底部写“完成”。
- 历史计划和复审记录保留，但不能出现在当前活动清单中。
- 文档规则本身的修改必须通过同一套 CI；不能用 CI 关闭文档门禁来修复文档门禁。

## 8. 文档语言政策（2026-08-26 起）

借鉴 MyPower 双语工件策略，结合本项目"单人作者 + AI agent"模式落地：

- **A 类（agent-facing）**：`AGENTS.md`、开发/架构/专题技术文档、`plans/` 实施计划与实施记录。**权威版本用英文**——agent 读英文效果更稳。新文件命名 `<name>.en.md`；现存中文文件保留原名，到该文件结构性修订时再整体转换。
- **B 类（human-facing 决策文档）**：Feature Spec、roadmap、project-status、README、CHANGELOG。**中文为权威版本**（作者审阅语言），保留现有文件名；当 agent 需要高频引用某份 B 类文档时，可为其建英文 companion（`<name>.en.md`），非强制。
- 双维护文档头部互相链接；语义冲突时按该类别的权威版本为准；同一 PR 中两份同步更新。
- **渐进迁移，不追溯存量**：历史中文文档（含已归档 phase 计划）不批量翻译。
- **单文件语言一致**：过渡期内不在同一文件内混用两种语言；转换以文件为单位整体进行。

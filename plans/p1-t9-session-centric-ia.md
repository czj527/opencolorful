# P1 T9：会话中心 IA 改造（lane log）

**日期：2026-08-27** · **执行：主 agent（UI 美学任务按约定不派发）** · 规格：`docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`（D1/D4a/D5）

## 方案

去掉全局"当前助理"概念，会话为中心：

- **数据层**：`Thread` 加 `agentId`（`SessionMetadata.agentId` 已存在，`GET /api/sessions` 本就跨助理返回，无新端点）；`listThreads()/listArchivedThreads()` 去 agentId 参数；新增 `updateAgentBaseColor`（PUT `/api/agents/:id/base-color`）。
- **侧栏**：删助理身份证卡/切换菜单/定时任务死区；头部改为"新建会话"主按钮+收起；会话行 badge（色点+名，仅助理 ≥2 时显示，`agentId=null` 历史会话不显示）；归档行带助理名。rail 去助理圆点组。
- **会话头 chip**：当前会话所属助理（色点+名+状态点：运行中/离线，空闲不渲染），点击进档案页。已落库会话归属锁定。
- **空态**：大身份证卡（AgentIdCard：左头像右字段——名称/编号（点击复制）/状态/描述，点击进档案页）+ 助理 chips（≥2 时，openhanako WelcomeScreen 模式）+ Composer + 高级新建…/新建助理…入口。
- **新会话默认助理推导**：显式选择 > 最近会话的助理 > 首个助理（无全局状态，纯派生）。
- **新建助理**：NewAgentDialog（名字+底色模板+可选默认工作目录，复用 createAgent/listAgentTemplates），入口在空态与高级新建表单助理选择器下。
- **档案页**：人设区从只读改为可编辑（回复风格 + 人格标签逗号分隔 → updateAgentBaseColor；innerSetting 不在 AgentProfileView 内，不提供编辑）。
- **记忆页**：多助理时页头加页内选择器（≥2 显示）。
- **mock 横幅**：琥珀色整条"当前为演示数据（后端未连接）"，不可关闭；`.app` 加 `has-mock-banner` 条件行（grid 三行）。
- **删除**：AgentCard.tsx/.css（被 AgentIdCard 取代）、styles.css 死样式（.agent-button/.rail-agents/.rail-agent）、Sidebar.css 死样式（.agent-card.is-empty）。

## 设计修正记录（实施中发现）

1. **chip 选择器死路**：草稿态（未发首条）渲染的是空态（无会话头），chip 的 selectable 浮层永不可达——砍掉，新会话归属选择收敛到空态 chips（与 openhanako 一致）。AgentChip 简化为只读身份+档案入口。
2. **T3 遗留 token 笔误**：NewSessionDialog.css 用了不存在的 `--danger`/`--danger-rgb`，边框静默失效；顺手修为 `--err`（本就在改这个文件）。

## 验证证据（主 agent 本 lane 独立执行）

- `npx tsc -p desktop/tsconfig.json --noEmit` ✓；`npx tsc --noEmit -p tsconfig.json`（根）✓
- `npx vitest run tests/unit/desktop-projector.test.ts` 11/11 ✓
- `npm run build --workspace=desktop` ✓（vite build 绿）
- `npm run check:docs` ✓
- 全量单测 `npx vitest run tests/unit`：1099/1100，唯一失败 `skills/detect-path-bins` 全 PATH 上限用例超时（45.9s > 20s）——**在未改动的 main 主仓复跑同样超时失败（40s）**，判定为本机 Windows 文件系统/Defender 环境耗时 flake，与 T9 无关（CI Linux 上该测试正常）
- 视觉冒烟（Playwright + vite mock 模式，截图在 `.tmp/`（lane 内，未提交））：会话列表 badge 分色正确；会话头 chip 显示会话自身助理（林间 thread → 林间 chip，Composer 占位跟随）；空态身份证卡字段齐全；新建助理弹窗模板可选；档案页人设编辑表单渲染；mock 横幅一行醒目
- **真实后端联测未做**（mock 截图 + 类型/构建/单测）；合并后建议作者用真实后端过一遍 I 组相关用例

## 已知偏差

- mock 模式下连接态本就显示"离线·mock 数据"，身份证卡状态行显示"离线"——语义上 mock≠离线，但横幅已解释演示态，接受。
- 记忆页/档案页的页内助理切换：档案页没有做页内切换（从哪个助理的 chip 进来就看谁；换助理回会话页点对应 chip），记忆页有。不对称是有意的：档案页是"某个助理"的详情，记忆页是浏览型页面。

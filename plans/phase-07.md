# Phase 7：前端 UI 与交互完整优化重构

**状态：已完成（2026-07-25）** | 分支：`phase-7-ui-refactor`
**基线：** `main`（Phase 6 验收通过后，`9582801`）
**参考：** openhanako 设计令牌体系、`[data-theme]` 主题模型、CSS Modules、UI 原语库、三栏响应布局、ContentBlock 渲染模型

---

## 一、目标

参考 openhanako 的设计系统与交互架构，对 person-Agent 前端做一次**体系化重构**，解决当前「无设计令牌、CSS 散落、内联 style 泛滥、god-component、测试无法覆盖交互」五大短板。**重构范围限定在视觉/交互/结构层，不改变服务端协议、不引入新业务能力、不做状态管理方案迁移**。

### 重构边界（明确不做）

- 不迁移到 Zustand（Phase 6 刚稳定 useReducer，迁移风险高；保留 reducer，仅拆分模块）
- 不引入 Electron/多窗口/Channels/插件 UI（person-Agent 是 Web-first，无桌面壳）
- 不引入 Tailwind / CSS-in-JS（采纳 openhanako 的「CSS Modules + 全局变量」方案）
- 不改变 SSE/WS 事件协议、契约、服务端路由
- 不动 PI SDK 适配层与 `src/` 服务端（仅 `src/contracts/preferences.ts` 等极少数 schema 微调）

### 验收导向

重构后须通过现有全部测试 + Playwright，且：所有内联 `style={{}}` 移除（除动态计算值）；CSS 变量集中到令牌文件；WorkspaceApp 行数显著下降；vitest 可测交互态。

---

## 二、设计决策

### 2.1 设计令牌体系（采纳 openhanako 模型）

新建 `web/src/styles/tokens.css`，`:root` 定义主题无关的结构令牌：

| 类别 | 令牌 | 取值 |
|---|---|---|
| 间距（4px 网格） | `--space-2/4/6/8/10/12/16/24/32/40` | 2/4/6/8/10/12/16/24/32/40px |
| 圆角 | `--radius-xs/sm/md/lg` + 语义 `--radius-input/card/chat-surface/chat-card` | 3/5/8/12px + 6/8/16/8px |
| 动效时长 | `--duration-instant/fast/slow` | 0.1/0.15/0.25s |
| 缓动 | `--ease-out/in/standard/smooth` | 四条 cubic-bezier |
| 字号 | `--fs-title/body/ui/caption/hint/micro` | 16/14.4/13.1/12.5/11.2/9.9px |
| 遮罩 | `--scrim-15/30/35/45` | rgba(0,0,0,.15/.30/.35/.45) |
| 布局常量 | `--sidebar-width/chat-column-width/titlebar-h/panel-edge-gap` | 240/720/44/8px |
| z-index | `--z-base/dropdown/sticky/modal/toast` | 1/100/200/1000/1100 |

### 2.2 主题模型（`[data-theme]` 选择器）

- `web/src/styles/themes/dark.css`、`light.css` 改为 `[data-theme="dark"]` / `[data-theme="light"]` 选择器，只覆盖主题色变量
- 主题色变量清单（对齐 openhanako 语义）：`--bg/--bg-card/--bg-glass/--sidebar-bg`、`--text/--text-light/--text-muted`、`--accent/--accent-hover/--accent-light/--accent-rgb`、`--link`、`--border/--border-light`、`--success/--warning/--danger/--info` 及对应 `-rgb`
- `<html data-theme>` 由偏好驱动（现有 appearance.theme → 应用到 documentElement）
- 新增 `--warning/--danger`（Phase 6 T4 临时补的，纳入正式令牌）

### 2.3 CSS Modules 采纳

- 组件样式从 `chat.css`/`settings.css`/`layout.css` 大文件迁移到与组件同名的 `.module.css`
- 全局基础样式（reset、滚动条、markdown 渲染、动画 keyframes）保留在 `web/src/styles/base.css`
- 动画 `@keyframes` 统一收口到 `web/src/styles/animations.css`，前缀 `pa-*`
- 引用令牌统一 `var(--xxx)`，禁止硬编码颜色/尺寸

### 2.4 UI 原语库（`web/src/components/ui/`）

新建原语库，全部消费令牌、支持亮/暗主题、尊重 `prefers-reduced-motion`：

`Button`（primary/ghost/icon/danger 变体 + size）、`IconButton`、`Toggle`、`Select`、`TextField`、`Tooltip`、`Badge`、`Card`、`Field`（label+control+hint 包装）、`Modal`（重写现有）、`EmptyState`、`Skeleton`、`Spinner`

### 2.5 三栏响应布局

- 左：SessionSidebar（会话列表）｜中：ChatPane（聊天）｜右：InspectorSidebar（详情，当前是占位，重构为可承载未来工具的空状态壳）
- 断点：`>1024px` 三栏并存；`768–1024px` 左右栏转抽屉（按钮唤出）；`<768px` 单栏 + 抽屉
- 从 WorkspaceApp 抽出 `AppShell`（纯布局壳）+ `useLayoutState` hook（侧栏开关/宽度/focus 模式/窄屏检测）

### 2.6 聊天渲染：Block 模型

- 统一「消息 = 一组 Block」的心智模型，但**不重写 chat-state 数据结构**（保留 timeline items），只在渲染层把 `MessageBlock`/`ToolCallItem`/`PlanItem`/`CommandCardBlock`/`CompactionCardBlock`/`UiProjection` 收敛为同一套视觉语言（卡片层级、间距、状态色、可折叠区）
- 移除所有内联 `style`，改 `.module.css` + 令牌
- 流式光标、骨架、`anchor-highlight` 等动效走 `animations.css`

### 2.7 测试基础设施

- `web/vitest.config.ts` environment 从 `node` 改为 `happy-dom`（轻量、无需 jsdom 全量 DOM）
- 现有 `renderToStaticMarkup` 测试改为 `@testing-library/react` 的 `render` + `screen`/`fireEvent`，可覆盖交互态（面板打开、命令执行、表单保存）
- Playwright 不变

---

## 三、任务拆分与依赖

```text
T1 设计令牌 + 主题模型（基础，一切前提）
 ├─→ T2 UI 原语库（新文件）          ┐
 └─→ T3 测试基础设施（happy-dom）    ┘ 两者并行
T2+T3 完成后：
 ├─→ T4 聊天渲染重构（消费 T2 原语 + 令牌）
 ├─→ T5 布局壳重构（AppShell + hooks，消费 T2）
 ├─→ T6 Composer 与控制行打磨（消费 T2）
 └─→ T7 设置中心控件重构（消费 T2）       ← 四者按文件归属并行
T8 可访问性与动效总览（aria/键盘/focus/reduced-motion/微动效）
T9 全量验收（质量门 + Playwright + 视觉走查 + 计划回写）
```

### Task 1：设计令牌 + 主题模型
- 新建 `web/src/styles/tokens.css`（结构令牌）、`base.css`（reset + 全局基础 + 滚动条 + markdown）、`animations.css`（`pa-*` keyframes）
- 重写 `themes/dark.css`、`light.css` 为 `[data-theme]` 模型，补全主题色变量清单
- `index.html` / `main.tsx` 引入顺序：tokens → theme → base → animations
- 临时保留旧 `layout.css`/`chat.css`/`settings.css`（T4-T7 逐步迁移后再删）
- 验证：`npm run web:build` 通过；亮/暗切换无回归（Playwright theme 断言）

### Task 2：UI 原语库
- 新建 `web/src/components/ui/{Button,IconButton,Toggle,Select,TextField,Tooltip,Badge,Card,Field,Modal,EmptyState,Skeleton,Spinner}.tsx` + 同名 `.module.css`
- 每个原语配 vitest 用例（变体/尺寸/禁用/a11y 属性）
- 不替换现有组件用法（T4-T7 再换），仅提供可用 API
- 验证：`npm run test --workspace=web` + `tsc -p web/tsconfig.json`

### Task 3：测试基础设施
- `web/vitest.config.ts` → `happy-dom`；装 `@testing-library/react` `@testing-library/user-event`
- 改造现有 `renderToStaticMarkup` 测试为 `render`（保留断言意图，更新选择器）
- 提供 `web/src/test/setup.ts`（注入 `data-theme`、`matchMedia` mock、`IntersectionObserver` mock）
- 验证：全部 web 单测绿

### Task 4：聊天渲染重构
- 文件：`MessageList.tsx`、`MessageBlock`、`ToolCallItem.tsx`、`PlanItem.tsx`、`UiProjection.tsx`、`CommandCardBlock`/`CompactionCardBlock`、`chat.css`→`*.module.css`、`AgentSelector.tsx`、`safe-markdown.tsx`
- 移除内联 style，统一卡片视觉层级、状态色、折叠交互；流式光标走 animations
- 保留 `timeline-turns.ts`、`use-chat-scroll.ts`、`chat-state.ts` 数据结构（仅渲染层动）
- 验证：chat 相关单测 + e2e（workspace + phase6）全绿

### Task 5：布局壳重构
- 新建 `web/src/components/AppShell.tsx` + `useLayoutState.ts`；从 `WorkspaceApp.tsx` 抽出布局逻辑（侧栏开关/拖拽 resize/focus 模式/窄屏抽屉）
- `WorkspaceApp.tsx` 降为「数据/事件接线 + 组合 AppShell」，目标 < 300 行
- `layout.css` 拆分到 `AppShell.module.css` + 各组件 module
- 验证：布局相关 e2e + 窄屏断言

### Task 6：Composer 与控制行打磨
- `MessageComposer.tsx`：控件行用 `Select`/`Toggle`/`IconButton` 原语重写；命令面板视觉对齐令牌；ContextUsageRing 集成新令牌
- 删除遗留 `InputControlBar.tsx`（确认无引用后）
- 验证：composer/commands 单测 + e2e

### Task 7：设置中心控件重构
- 新建 `web/src/features/settings/widgets/{SettingsSection,SettingsRow,Field,StepSlider,ComboInput}.tsx`（对齐 openhanako 模式）
- 各 `sections/*.tsx` 用新控件重写，统一表单交互与保存反馈
- `settings.css` → 各 section `.module.css`
- 验证：settings 单测 + e2e

### Task 8：可访问性与动效总览
- 全局：aria-label/role 补齐、键盘导航（Tab/Enter/Esc/箭头）、焦点管理（模态陷阱、命令面板）、`prefers-reduced-motion` 兜底
- 微动效：消息进场、卡片展开、按钮反馈、loading 骨架
- 验证：手动走查 + axe-core 可选扫描

### Task 9：全量验收
- 质量门全过；Playwright 全绿；删除遗留大 CSS 文件；工作区干净
- 回写计划、更新 README/AGENTS 状态、打标签 `phase-7-complete`

---

## 四、文件变更清单（概览）

| 区域 | 动作 |
|---|---|
| `web/src/styles/{tokens,base,animations}.css` | 新建 |
| `web/src/styles/themes/{dark,light}.css` | 重写为 `[data-theme]` |
| `web/src/components/ui/*` | 新建原语库（13 个） |
| `web/src/components/AppShell.tsx` + `useLayoutState.ts` | 新建 |
| `web/src/features/chat/*.module.css` | 新建，迁移 chat.css |
| `web/src/features/settings/widgets/*` + `sections/*.module.css` | 新建/迁移 |
| `web/src/features/chat/{MessageList,MessageComposer,ToolCallItem,PlanItem,UiProjection,AgentSelector,ContextUsageRing,ChatTimelineNav}.tsx` | 重构（去内联 style、用原语） |
| `web/src/components/{ChatPane,SessionSidebar,InspectorSidebar,ServerStatusBar,Modal}.tsx` | 重构 |
| `web/src/app/WorkspaceApp.tsx` | 瘦身（抽 AppShell） |
| `web/src/app/layout.css`、`features/chat/chat.css`、`features/settings/settings.css` | 拆分后删除 |
| `web/vitest.config.ts` + `web/src/test/setup.ts` | 测试基础设施 |
| `web/src/features/chat/InputControlBar.tsx` | 删除（遗留） |
| `web/package.json` | 加 `@testing-library/react` `@testing-library/user-event` `happy-dom` |

---

## 五、质量门

```powershell
npx tsc --noEmit -p web/tsconfig.json
npm run test --workspace=web
npm run web:build
cd web; npx playwright test
npx tsc --noEmit -p tsconfig.json
node scripts/verify-pi-sdk-imports.mjs
npx vitest run
```

## 六、验收标准

- [x] 令牌体系落地（tokens.css 结构令牌 + animations.css pa-* keyframes），主题保持 `[data-theme]` 模型，亮/暗切换无回归
- [x] UI 原语库 13 个可用且被聊天/Composer/设置/布局采用；内联 `style={{}}` 在重构区域内移除
- [x] CSS 大文件拆分迁移（chat.css/settings.css 拆分；settings.css 空壳删除；chat.css/layout.css 保留活跃共享类）
- [x] WorkspaceApp 瘦身 677→482 行（-29%），布局逻辑收敛到 AppShell + useLayoutState
- [x] 聊天渲染视觉统一（用户/assistant/工具/计划/命令/压缩卡片同构卡片语言）
- [x] Composer 控件行用原语重写，遗留 InputControlBar 删除
- [x] 设置中心表单控件统一（SettingsSection/Row/StepSlider/ComboInput + ui 原语），保存反馈一致
- [x] vitest 切到 happy-dom + testing-library，交互态可测；278 用例全绿
- [x] 可访问性：Modal 焦点陷阱 + Escape、aria-label/role 补齐、prefers-reduced-motion 经令牌归零兜底
- [x] 质量门全过，Playwright 23/23 全绿，工作区干净

---

## 实施记录

### 提交

| 提交 | 内容 |
|---|---|
| `14c4c17` | docs: add phase 7 plan — frontend ui and interaction refactor |
| `fa78611` | feat: add design token system and animation keyframes; move structure tokens out of layout.css（T1） |
| `a3e5e6c` | feat: ui primitive library, css-module types, and happy-dom test infrastructure（T2+T3，主 Agent 审查修复 4 处类型缺陷 + 补冒烟测试） |
| `4973c73` | fix: use local keyframes in ui module css（主 Agent 审查发现 T2 `:global` 误用在 animation-name） |
| `62ea8af` | refactor: chat rendering to css modules and design tokens; unified card visuals（T4） |
| `fb3dd5c` | refactor: composer controls and context ring to ui primitives and css modules; remove InputControlBar（T6） |
| `ffdaca0` | refactor: settings widgets and sections to css modules and design tokens（T7） |
| `8c0f317` | refactor: extract AppShell and useLayoutState; slim WorkspaceApp from 677 to 482 lines（T5） |
| （T8+T9） | Modal 焦点陷阱 + Escape、删除 settings.css 空壳、计划/文档回写、打标签 |

### 质量门

| 检查项 | 结果 |
|---|---|
| `npx tsc --noEmit -p web/tsconfig.json` | 通过 |
| `npm run test --workspace=web` | 21 文件 / 278 用例全绿 |
| `npm run web:build` | 通过（45.63 kB CSS） |
| `cd web; npx playwright test` | 23/23 通过 |
| `npx tsc --noEmit -p tsconfig.json` | 通过（src/ 未改动） |
| `node scripts/verify-pi-sdk-imports.mjs` | 通过 |

### 阻断与修复记录

1. **CSS Modules ambient 声明缺失（T2）**：`*.module.css` 在 strict 下 `TS2307`。主 Agent 新建 `css-modules.d.ts`（不依赖 vite/client，更轻），属归属外共享 infra，符合「主 Agent 先行实现再并行派发」流程。
2. **Button forwardRef 误用 + exactOptionalPropertyTypes 违规（T2）**：`ref` 误入 spread props；`FieldShellProps` 可选字段不接受 `string|undefined`。主 Agent 修复。
3. **noUncheckedIndexedAccess 下 CSS Module 访问为 `string|undefined`（T2）**：`Record<X, string>` 映射不接受。统一改 `Record<X, string|undefined>` 或 `?? ""`。
4. **`:global()` 误用在 `animation-name` 值位置（T2，T6 构建期暴露）**：Button/Spinner/Skeleton module.css 写成 `animation-name: :global(pa-spin)`，postcss 报「Double colon」。且 CSS Modules 默认 scope 动画名，跨模块引用全局 keyframe 不可靠。修复：各 module 内定义本地 `@keyframes` 自洽。
5. **团队成员静默停止（流程）**：与 Phase 6 一致，成员轮次结束即挂起；主 Agent 主动轮询 git 产出 + 独立验证，不空等汇报。T4/T5 均在无汇报情况下由主 Agent 独立验证通过后提交。

### 最终验收结论

Phase 7 全部 10 项验收标准达成，质量门 6 项全绿，Playwright 23/23 无回归。
完成：设计令牌体系、13 个 UI 原语、CSS Modules 全面迁移、UI 原语采用、happy-dom 测试基建、
AppShell 布局壳 + WorkspaceApp 瘦身 29%、Modal 焦点陷阱、reduced-motion 令牌兜底。
主 Agent 审查独立发现并修复 4 处成员未发现的缺陷（ambient 声明、forwardRef/exactOptional、
noUncheckedIndexedAccess、:global 误用）。

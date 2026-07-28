# Phase 8 补充修正：Agent 管理与底色创建体验实施计划

> **状态：已完成并验收（2026-07-28）**。实现已纳入 Phase 8，最终验收与质量门记录见 `plans/phase-08.md`。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent 管理从设置页内联表单重构为独立路由页面体系（`/agents/new` + `/agents/:id` + 纯列表管理页），新增 TagInput、ConfirmDiscard 组件，编辑页补齐名称修改。

**Architecture:** 4 波串行/并行推进。Wave 1（infra 并行）：page-router + TagInput + ConfirmDiscard。Wave 2：共享 AgentForm。Wave 3（并行）：AgentCreatePage + AgentEditPage + AgentsSection。Wave 4：App.tsx/SettingsPage 整合。Wave 5：主 Agent E2E + 质量门。

**Tech Stack:** React + TypeScript + CSS Modules + Vitest + Playwright

---

## Wave 1：基础设施（并行，3 个子 Agent）

### Task 1: page-router 扩展

**目标：** 新增 `agent-new`、`agent-edit` 路由和导航函数

**文件：**
- Modify: `web/src/app/page-router.ts`

**需求清单：**
- `routeFromPathname()` 识别 `/agents/new` → `"agent-new"`，`/agents/:id` → `"agent-edit"`
- 新增 `navigateToAgentNew()` → `pushState({}, "", "/agents/new")`
- 新增 `navigateToAgentEdit(agentId: string)` → `pushState({}, "", "/agents/${agentId}")`
- 新增 `navigateToSettingsSection(section: string)` → `pushState({}, "", "/settings?section=${section}")`
- `PageRoute` 类型扩展为 `"workspace" | "settings" | "session-new" | "agent-new" | "agent-edit"`

---

### Task 2: TagInput 组件

**目标：** 标签输入器，支持键盘添加/删除、点击删除、去重

**文件：**
- Create: `web/src/features/agents/TagInput.tsx`
- Create: `web/src/features/agents/TagInput.module.css`
- Create: `web/src/features/agents/TagInput.test.tsx`

**组件接口：**
```tsx
interface TagInputProps {
  readonly tags: readonly string[];
  readonly onChange: (tags: string[]) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}
```

**行为：**
- 容器 flex-wrap，标签 + 末尾 0 宽度 input（通过内容自动撑开）
- Enter 或 `,` → 创建标签，清空 input，焦点保持
- Backspace 在空 input → 删除最后一个标签
- 点击标签 × → 删除
- 去重（大小写敏感，trim 后比较）
- 空字符串不创建标签

**CSS 要求：**
- 标签：`var(--bg-tertiary)` 背景 + `var(--radius-sm)` 圆角 + 小 padding
- × 按钮：hover 变红
- input：无边框、无背景、继承字体、min-width: 60px
- 整体容器：flex-wrap、gap var(--space-6)、min-height 36px、focus-within 边框高亮

---

### Task 3: ConfirmDiscard 组件

**目标：** 通用放弃确认弹窗，create/edit 两种文案

**文件：**
- Create: `web/src/features/agents/ConfirmDiscard.tsx`
- Create: `web/src/features/agents/ConfirmDiscard.module.css`
- Create: `web/src/features/agents/ConfirmDiscard.test.tsx`

**组件接口：**
```tsx
interface ConfirmDiscardProps {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  readonly onStay: () => void;
  readonly onDiscard: () => void;
}
```

**文案：**
- create: title="放弃创建？" body="已填写的内容将不会保留。" confirm="放弃" cancel="继续编辑"
- edit: title="放弃更改？" body="你有未保存的修改，离开后将丢失。" confirm="放弃更改" cancel="继续编辑"

**实现：**
- 复用现有 Modal 组件（`web/src/components/Modal.tsx`）
- 使用设计令牌，不写硬编码颜色

---

## Wave 2：共享表单骨架（1 个子 Agent）

### Task 4: AgentForm 组件

**目标：** create/edit 共享表单骨架，包含所有字段和操作栏

**文件：**
- Create: `web/src/features/agents/AgentForm.tsx`
- Create: `web/src/features/agents/AgentForm.module.css`
- Create: `web/src/features/agents/AgentForm.test.tsx`

**组件接口：**
```tsx
type AgentFormMode = "create" | "edit";

interface AgentFormDraft {
  name: string;
  persona: string;
  personality: string[];
  replyStyle: string;
  innerSetting: string;
  defaultCwd: string | null;
  // create only
  selectedTemplateKey: string;
  templateAdjusted: boolean;
}

interface AgentFormProps {
  readonly mode: AgentFormMode;
  readonly draft: AgentFormDraft;
  readonly onChange: (patch: Partial<AgentFormDraft>) => void;
  readonly onSubmit: () => Promise<void>;
  readonly onCancel: () => void;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly dirty: boolean;          // edit: 是否有未保存修改
  readonly templates?: BaseColorTemplate[];  // create only
  readonly templatesLoading?: boolean;
  readonly templatesError?: string | null;
  readonly saved?: boolean;         // edit: 是否已保存成功
}
```

**字段渲染：**
1. **名称** — TextField，必填，placeholder="例如：小蓝"
2. **模板区** — 仅 mode="create"：
   - BaseColorTemplatePicker（复用现有组件）
   - 已有修改时（draft.templateAdjusted && dirtyExceptTemplate）→ 内联覆盖确认
3. **角色描述** — TextField multiline rows={4}，label="角色描述"
4. **性格特质** — TagInput，label="性格特质"
5. **回复风格** — TextField，label="回复风格"
6. **内在设定** — TextField multiline rows={4}，label="内在设定"
7. **默认工作目录** — DirectoryPicker（复用现有组件）
8. **固定操作栏** — sticky bottom：
   - create: [取消] / [创建 Agent]
   - edit: [返回] / [保存更改]

**布局：**
- 居中内容区 max-width: 640px，左右 auto margin
- 使用留白和细分隔线组织区域
- 模板区是唯一的重复卡片组
- 固定操作栏 sticky bottom，不遮挡最后字段

**关键逻辑：**
- `dirtyExceptTemplate`：判断 name/baseColor/cwd 是否相对初始值有变化（忽略模板相关字段）
- 模板选择 → `onChange({ persona, personality, replyStyle, innerSetting, selectedTemplateKey, templateAdjusted: false })`
- 手动编辑 → `onChange({ ..., templateAdjusted: true })`（保留 selectedTemplateKey）
- 覆盖确认 → 用户确认后 `onChange` 填充模板值，清除 `templateAdjusted`

---

## Wave 3：页面组件（并行，3 个子 Agent）

### Task 5: AgentCreatePage

**目标：** `/agents/new` 独立创建页，加载模板和 agents 列表，调用创建 API

**文件：**
- Create: `web/src/features/agents/AgentCreatePage.tsx`
- Create: `web/src/features/agents/AgentCreatePage.module.css`
- Create: `web/src/features/agents/AgentCreatePage.test.tsx`

**职责：**
1. `useEffect` → `api.getBaseColorTemplates()` + `api.listAgents()`
2. 管理 draft state（初始值：空白底色 + selectedTemplateKey="" + templateAdjusted=false）
3. 模板选择覆盖逻辑
4. `handleSubmit` → `api.createAgent(name, baseColor, defaultCwd)` → 成功跳转 `/settings?section=agents&highlight=<newId>`
5. 创建失败保留 draft + 显示错误
6. `handleCancel` → 有修改先 ConfirmDiscard，否则直接跳转
7. 路由离开拦截（popstate → 检查 dirty → ConfirmDiscard）

**文案：**
- 页面标题：新建 Agent
- 操作栏：[取消] [创建 Agent]
- 模板区标题：选择底色起点

---

### Task 6: AgentEditPage

**目标：** `/agents/:id` 独立编辑页，加载单个 Agent，支持修改名称/底色/cwd

**文件：**
- Create: `web/src/features/agents/AgentEditPage.tsx`
- Create: `web/src/features/agents/AgentEditPage.module.css`
- Create: `web/src/features/agents/AgentEditPage.test.tsx`

**职责：**
1. 从 URL 提取 agentId（解析 `window.location.pathname`：`/agents/<id>`）
2. `useEffect` → `api.getAgent(id)`
3. 404 → 居中错误卡片："Agent 不存在或已归档" + "返回 Agent 管理"按钮
4. 加载中 → 骨架或 spinner
5. 加载成功 → 初始化 draft（等同于 API 返回值）
6. `handleSubmit` → 并行调用：
   - `api.updateAgent(id, name)`（仅 name 变化时）
   - `api.updateAgentBaseColor(id, { persona, personality, replyStyle, innerSetting })`
   - `api.updateAgentSettings(id, { defaultCwd })`
   - 任一失败 → 显示具体失败项，保留 draft，不显示整体成功
7. 保存成功 → `saved=true`，清除 dirty，停留当前页
8. `handleCancel` → dirty 时 ConfirmDiscard，否则跳转 `/settings?section=agents`
9. beforeunload + popstate 拦截

**文案：**
- 页面标题：编辑 {agentName}
- 操作栏：[返回] [保存更改]
- 保存成功后操作栏上方显示绿色"已保存"提示
- 不显示模板区

---

### Task 7: AgentsSection 重写

**目标：** 退化为纯 Agent 列表组件，卡片展示基本信息 + 更多菜单

**文件：**
- Modify: `web/src/features/settings/sections/AgentsSection.tsx`（重写）
- Modify: `web/src/features/settings/sections/AgentsSection.module.css`
- Modify: `web/src/features/settings/sections/agents-section.test.tsx`（重写）

**新 props：**
```tsx
interface AgentsSectionProps {
  readonly agents: readonly AgentView[];
  readonly highlightedAgentId?: string | null;
  readonly onNavigateNew: () => void;
  readonly onNavigateEdit: (id: string) => void;
  readonly onArchive: (id: string) => Promise<void>;
}
```

**卡片内容：**
- AgentAvatar（首字 + 装饰色，复用现有组件）
- 名称（粗体）
- 会话数（`{n} 会话`，次要文字）
- 默认工作目录：截断显示（50 字符），hover title 完整路径；null 显示"未设置"
- 更多菜单（⋮ 按钮，点击展开 popover）：
  - "归档 Agent" → 调用 `onArchive(id)`

**高亮逻辑：**
- 接收 `highlightedAgentId`
- 匹配的卡片：短暂高亮动画（2s 背景色过渡 → 恢复），`useEffect` + setTimeout 清除
- 无匹配时无动画

**移除：**
- 内联创建表单（所有 createForm state 和 UI）
- 内联编辑表单（所有 expandedId + editForm state 和 UI）
- `BaseColorTemplatePicker` 导入
- `onCreate`、`onSaveBaseColor`、`saving`、`lastSaveError` props

---

## Wave 4：整合（1 个子 Agent）

### Task 8: App.tsx + SettingsPage 整合

**目标：** 接入新页面组件，传递高亮状态

**文件：**
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/features/settings/SettingsPage.tsx`

**App.tsx 改动：**
1. 导入 `AgentCreatePage`、`AgentEditPage`
2. 新增 `highlightedAgentId` state
3. `route === "agent-new"` → 渲染 `<AgentCreatePage api={api} onCreated={(id) => { setHighlightedAgentId(id); navigateToSettingsSection('agents'); }} />`
4. `route === "agent-edit"` → 渲染 `<AgentEditPage api={api} />`
5. SettingsPage 接收 `highlightedAgentId` + `onHighlightConsumed` 回调
6. agent-new / agent-edit 路由下独立加载数据，与 session-new 模式一致

**SettingsPage 改动：**
1. 新 props：`highlightedAgentId?: string | null`、`onHighlightConsumed?: () => void`
2. 传递给 `AgentsSection`：`highlightedAgentId`、`onNavigateNew`、`onNavigateEdit`
3. AgentsSection 不再需要 `onCreate`、`onSaveBaseColor`、`saving`、`lastSaveError`
4. `handleCreateAgent`、`handleSaveAgentBaseColor` 回调移除
5. 简化 `SectionRenderProps` 中的 Agent 相关 props

---

## Wave 5：端到端验证（主 Agent）

### Task 9: E2E 测试 + 全质量门

**目标：** 补充 Playwright E2E 测试，运行全质量门

**文件：**
- Create: `web/tests/e2e/agent-management.spec.ts`

**E2E 测试场景：**

1. **管理列表 → 创建页 → 创建 → 高亮**
   - 进入 `/settings?section=agents`
   - 点击 "+ 新建 Agent" → 跳转 `/agents/new`
   - 选蓝色模板 → 验证表单填充
   - 填名称 → 创建
   - 跳回设置页 → 新 Agent 出现在列表并短暂高亮

2. **管理列表 → 编辑页 → 改名称 → 保存**
   - 点击已有 Agent 卡片 → 跳转 `/agents/:id`
   - 修改名称 → 保存
   - 显示"已保存" → 返回列表 → 名称已更新

3. **模板覆盖确认**
   - `/agents/new` 选蓝色模板
   - 手动改角色描述 → 显示"已调整"
   - 切换橙色模板 → 内联覆盖确认
   - 确认 → 表单填充橙色内容，"已调整"消失

4. **标签输入**
   - 创建页输入"理性" → Enter → 标签出现
   - 输入"严谨" → Enter → 第二个标签
   - 点击第一个标签的 × → 删除
   - 输入"理性" → 不再重复添加

5. **目录选择取消**
   - 创建页点"选择目录"（mock API 返回 `{cancelled: true}`）
   - 路径保持不变

6. **未保存保护**
   - 编辑页修改名称 → 点"返回"
   - Modal 出现"放弃更改？"
   - "继续编辑" → 留在编辑页
   - "放弃更改" → 跳回设置页

7. **创建失败保留草稿**
   - Mock 创建 API 返回 500
   - 填表提交 → 错误提示 → 表单内容保持不变

8. **桌面/窄屏布局**
   - 1280px 模板单行
   - 390px 单列
   - 固定操作栏不遮挡最后字段

**质量门验证：**
- PI import 边界
- tsc strict
- 服务端 Vitest
- Web Vitest
- Web 构建
- tsconfig.build.json
- Playwright 全量

---

## 并行规则

| Wave | 任务 | 可并行 | 条件 |
|------|------|--------|------|
| 1 | T1 + T2 + T3 | ✅ 3 并行 | 无共享文件、无前后依赖 |
| 2 | T4 | 串行 | 依赖 T2、T3 |
| 3 | T5 + T6 + T7 | ✅ 3 并行 | 三者无共享文件（各自 page + css + test） |
| 4 | T8 | 串行 | 依赖 T4-T7 |
| 5 | T9 + 质量门 | 主 Agent 串行 | 依赖 T1-T8 全部完成 |

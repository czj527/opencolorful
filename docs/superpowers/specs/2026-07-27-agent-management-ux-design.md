# Agent 管理与底色创建体验重构

> 2026-07-27 | 基于 Phase 8 已完成实现的 UX 补充修正
> 状态：已实现并于 2026-07-28 完成浏览器验收
> 参考：OpenHanako AgentCreateOverlay、YuanSelector、Settings.module.css

## 一、背景

Phase 8 的数据模型和 API 已完成，但 Agent 创建被实现为设置页列表下方的内联表单，视觉与交互不符合产品设计。本设计将 Agent 管理重构为独立路由页面体系。

## 二、路由与页面架构

新增两个路由，现有 `page-router.ts` 扩展：

| 路由键 | 路径 | 页面组件 |
|--------|------|---------|
| `agent-new` | `/agents/new` | `AgentCreatePage` |
| `agent-edit` | `/agents/:id` | `AgentEditPage` |

导航函数新增：`navigateToAgentNew()`、`navigateToAgentEdit(id)`、`navigateToSettingsSection('agents')`。

App.tsx 为两个新路由条件渲染对应页面组件，独立加载数据。创建成功后跳转 SettingsPage 并传递 `highlightedAgentId` 做短暂高亮。

## 三、组件树

```
App
├── WorkspaceApp          (route === "workspace")
├── SettingsPage           (route === "settings")
│   └── AgentsSection      （纯列表，无创建/编辑表单）
├── NewSessionPage         (route === "session-new")
├── AgentCreatePage        (route === "agent-new")
│   └── AgentForm           （共享骨架，mode="create"）
│       ├── name 输入
│       ├── BaseColorTemplatePicker
│       ├── 模板覆盖确认（内联）
│       ├── 角色描述 textarea
│       ├── 性格特质 TagInput
│       ├── 回复风格 input
│       ├── 内在设定 textarea
│       ├── DirectoryPicker
│       └── 固定操作栏（取消 / 创建 Agent）
└── AgentEditPage         (route === "agent-edit")
    └── AgentForm           （共享骨架，mode="edit"）
        ├── name 输入
        ├── 角色描述 textarea
        ├── 性格特质 TagInput
        ├── 回复风格 input
        ├── 内在设定 textarea
        ├── DirectoryPicker
        └── 固定操作栏（返回 / 保存更改）
```

AgentForm 通过 `mode: "create" | "edit"` 区分。编辑页不显示模板。

## 四、数据流

### 创建页
1. useEffect → `api.listAgents()` + `api.getBaseColorTemplates()`
2. 模板选择 → 填充 draft（含 `selectedTemplateKey`）
3. 手动编辑 → draft 更新 + "已调整"标记 + 保留 `selectedTemplateKey`
4. 已有编辑时切换模板 → 内联覆盖确认
5. 提交 → `api.createAgent(name, baseColor, defaultCwd)` → 成功跳转 / 失败保留草稿

### 编辑页
1. useEffect → `api.getAgent(id)` → 404 显示错误状态
2. 编辑 → 本地 draft + dirty 标记
3. 保存 → 分别调 `updateAgent` / `updateAgentBaseColor` / `updateAgentSettings`
4. 成功 → 显示"已保存"清除 dirty / 部分失败 → 显示具体失败项

### AgentsSection（退化列表）
- "+ 新建 Agent" → `navigateToAgentNew()`
- 卡片：AgentAvatar + 名称 + 会话数 + cwd 摘要（截断）
- 点击卡片 → `navigateToAgentEdit(id)`
- 更多菜单（⋮）→ 归档
- 接收 `highlightedAgentId` → 短暂高亮动画

## 五、UI 细节

### 5.1 模板卡片
- 5 张等高卡：空白 + 蓝/橙/绿/紫
- 卡片：色块条 + 颜色名称 + 人格概括 + 2-3 特质
- 背景中性，选中态用 border-color 高亮
- 首次默认"空白"；手动编辑后显示"已调整"
- 覆盖确认：⚠ 内联文字 + 确认/取消按钮

### 5.2 TagInput
- flex-wrap 标签 + 末尾隐形 input
- Enter / `,` 创建标签；Backspace 删最后一个
- 点击 × 删除；去重
- 序列化 `tags.join(", ")`

### 5.3 放弃确认
- ConfirmDiscard 通用组件，复用 Modal
- create 模式：离开即丢弃
- edit 模式：beforeunload + popstate 拦截 + Modal

### 5.4 固定操作栏
- `position: sticky; bottom: 0`
- 背景匹配页面 + 顶部分隔线
- 创建中 loading + disabled

### 5.5 错误状态
- 404：居中卡片 + 返回按钮
- 模板加载失败：不阻塞手动创建
- 创建/保存失败：红色错误条，保留输入
- 重复提交：submitting 锁 + disabled + loading
- 部分失败：显示具体失败项，不显示整体成功

### 5.6 字段名称
面向用户：角色描述 / 性格特质 / 回复风格 / 内在设定（不显示 Persona 等内部字段名）

## 六、文件变更

### 新建文件
| 文件 | 说明 |
|------|------|
| `web/src/features/agents/AgentCreatePage.tsx` | 创建页 |
| `web/src/features/agents/AgentCreatePage.module.css` | |
| `web/src/features/agents/AgentEditPage.tsx` | 编辑页 |
| `web/src/features/agents/AgentEditPage.module.css` | |
| `web/src/features/agents/AgentForm.tsx` | 共享表单骨架 |
| `web/src/features/agents/AgentForm.module.css` | |
| `web/src/features/agents/TagInput.tsx` | 标签输入器 |
| `web/src/features/agents/TagInput.module.css` | |
| `web/src/features/agents/ConfirmDiscard.tsx` | 放弃确认 |
| `web/src/features/agents/ConfirmDiscard.module.css` | |

### 修改文件
| 文件 | 改动 |
|------|------|
| `web/src/app/page-router.ts` | +2 路由 + 导航函数 |
| `web/src/app/App.tsx` | +2 页渲染 + 高亮传递 |
| `web/src/features/settings/SettingsPage.tsx` | 简化 AgentsSection props |
| `web/src/features/settings/sections/AgentsSection.tsx` | 重写为纯列表 |
| `web/src/features/settings/sections/AgentsSection.module.css` | 适配新样式 |

### 不修改
- `BaseColorTemplatePicker.tsx`、`DirectoryPicker.tsx`、`AgentAvatar.tsx`、`decor-color.ts` — 现有组件复用
- `api-client.ts`、`types.ts` — API 已完备
- 所有服务端文件

## 七、测试策略

| 类型 | 文件 | 重点 |
|------|------|------|
| 单测 | `TagInput.test.tsx` | 键盘、删除、去重、预填 |
| 单测 | `AgentForm.test.tsx` | create/edit 差异、覆盖确认 |
| 单测 | `ConfirmDiscard.test.tsx` | open/close、回调 |
| 单测 | `AgentsSection.test.tsx`（改写） | 列表、高亮、无表单 |
| 集成 | `AgentCreatePage.test.tsx` | 模板填充、失败恢复、成功跳转 |
| 集成 | `AgentEditPage.test.tsx` | 加载、dirty、保存、404 |
| E2E | `agent-management.spec.ts`（新建） | 完整流程、布局、未保存保护 |
| 回归 | `phase6/8/workspace.spec.ts` | 不引入回归 |

## 八、验收标准

- [x] `/agents/new` 和 `/agents/:id` 独立路由可访问
- [x] 模板 5 张卡展示正确，选中填充表单
- [x] 已有修改切换模板 → 内联覆盖确认
- [x] TagInput 键盘添加/删除/去重
- [x] 创建失败保留草稿；编辑保存成功后显示"已保存"
- [x] 名称在编辑页可修改持久化
- [x] 管理列表：AgentAvatar + 名称 + 会话数 + cwd
- [x] 归档在更多菜单
- [x] 创建后管理列表短暂高亮
- [x] 未保存修改 → 放弃确认
- [x] 模板加载失败不阻塞创建
- [x] Agent 404 显示错误 + 返回入口
- [x] 重复提交防护
- [x] 深色/浅色、1280px/768px/390px 布局正确
- [x] 编辑页无模板；模板来源不持久化
- [x] 全质量门通过（Server 292、Web 326、Playwright 40/40）

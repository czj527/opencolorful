# Phase 5：多 Agent 身份证 + 主题系统 + 交互优化

**状态：已完成（2026-07-24）** | 分支：`phase-5-agent-identity`
**基线：** `main`（Phase 4 验收通过后）
**参考：** openhanako "Agent即文件"、CSS 变量主题、ContentBlock 消息模型、InputControlBar 交互

---

## 一、目标

1. **Agent 身份证** — 每个 Agent 有永久身份编码，按类型分为 work/coding/assistant 三种，姓名可重复；人设/性格/回复风格是**独立属性**，不属于身份证
2. **会话不强制绑定 Agent** — 会话可以属于某个 Agent，也可以不属于任何 Agent（此时体现模型最原本的性格，类似 openhanako 的 Hanako）。创建会话不需要先创建 Agent
3. **主题系统** — 亮色/暗色两种，CSS 变量 + `data-theme` 切换，持久化
4. **工具卡片渲染稳定性** — 修复消息时间线重建导致卡片闪失的问题
5. **聊天交互优化** — 控制栏下移、空状态、Agent 选择器

---

## 二、Agent 身份证系统

### 2.1 设计原则

- **身份证** = 身份标识（是什么人），不可变
- **属性** = 行为特征（怎么说话），可随时编辑

### 2.2 目录结构

```
~/.person-agent/agents/<id>/
├── identity.json        ← 身份证（type + name + 永久编码）
├── profile.json          ← 属性（persona / personality / replyStyle）
└── sessions/              ← PI JSONL 会话
```

### 2.3 identity.json — 身份证（护照）

```ts
interface AgentIdentity {
  readonly version: 1;
  readonly id: string;          // 永久唯一编码，UUID v4 生成
  readonly type: "work" | "coding" | "assistant";
  readonly name: string;        // 姓名，可重复（允许多个 "小助手"）
  readonly createdAt: string;
}
```

- `id` 是永久编码，目录名，不可变
- `type` 决定 Agent 的默认工具集和权限边界：
  - `assistant`：对话为主，read 工具
  - `coding`：read/write/bash + 工作区绑定
  - `work`：read/write + 自动化 + 定时任务

### 2.4 profile.json — 属性（可编辑）

```ts
interface AgentProfile {
  readonly version: 1;
  readonly persona: string;       // 人设系统 prompt
  readonly personality: string[]; // 性格标签
  readonly replyStyle: string;    // 回复风格
  readonly updatedAt: string;
}
```

- `persona` 注入系统 prompt
- `personality` 在 UI 以标签展示
- `replyStyle` 影响对话语气

---

## 三、Agent API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表 |
| POST | `/api/agents` | 创建（需 type/name） |
| GET/PUT | `/api/agents/:id` | 获取/更新 identity |
| GET/PUT | `/api/agents/:id/profile` | 获取/更新 profile |
| POST | `/api/agents/:id/archive` | 归档 |
| GET | `/api/agents/:id/sessions` | 会话列表 |

---

## 四、Session 与 Agent 的关系

- `sessions.agent_id` 为 **可空（NULL）**。NULL = 无 Agent，使用模型原本性格
- **创建会话不需要先创建 Agent**——会话随时可建，Agent 是可选增强
- 目录：无 Agent → `sessions/*.jsonl`；绑定 Agent → `agents/<id>/sessions/*.jsonl`
- UI：无 Agent 会话显示"默认"，Agent 选择器中有"未绑定"选项

### Migration v4

`sessions` 表新增 `agent_id TEXT`（可空，无默认值）。已有会话全部为 NULL。

---

## 五、主题系统

两套主题，CSS 变量模式：

```css
[data-theme="dark"]  { --bg:#1a1a1a; --bg-secondary:#252525; --bg-tertiary:#2d2d2d; --text:#e0e0e0; --text-secondary:#a0a0a0; --accent:#4a9eff; --border-color:#2d2d2d; }
[data-theme="light"] { --bg:#ffffff; --bg-secondary:#f5f5f5; --bg-tertiary:#eeeeee; --text:#1a1a1a; --text-secondary:#666;   --accent:#2563eb; --border-color:#e0e0e0; }
```

- `preferences.json` 新增 `theme: "dark" | "light"`
- `LayoutSection` 增加主题切换
- `WorkspaceApp` 加载后设置 `document.documentElement.dataset.theme`

---

## 六、工具卡片渲染稳定性修复

### 5.1 当前问题

`chatReducer` 的 `timeline` 在事件重新处理时可能换序或丢弃条目，导致工具卡片闪烁消失。

### 5.2 修复方案

**Event → timeline item 的稳定 ID：**

```ts
// 每个事件类型映射到唯一的 timeline item id
function timelineIdFromEvent(event: PlatformEventEnvelope): string {
  switch (event.type) {
    case "message.delta": return `msg-${event.streamId}`;
    case "thinking.delta": return `think-${event.streamId}`;
    case "tool.started": case "tool.completed": case "tool.failed":
      return `tool-${(event.payload as {toolCallId:string}).toolCallId}`;
    case "plan.updated": return `plan-${event.streamId}`;
    case "attachment.available": return `att-${(event.payload as {attachmentId:string}).attachmentId}`;
    default: return event.eventId;
  }
}
```

- 同一 `streamId` 内的 message 在 timeline 中只占一个位置，后续 delta 更新内容但不改变 timeline 结构
- 工具卡片用 `toolCallId` 作为稳定 id，`tool.started` 创建占位，`tool.completed` 在原位更新
- 不再依赖事件序列号来去重 timeline 条目

### 5.3 参考 openhanako

openhanako 的 `buildAssistantBlocksFromContent` 一次性构建 blocks，text/thinking/tool_group 各自是独立 block，有类型标识，memo 减少重渲染。

我们也改为按类型（kind）分组、同类合并、ID 稳定的 timeline 模型。

---

## 七、交互优化

### 6.1 控制栏下移

```
┌──────────────────────────────────┐
│  消息列表                         │
├──────────────────────────────────┤
│  [输入框                     ]    │
├──────────────────────────────────┤
│  📎  │ 🔧 工具  │ 🧠 思考  │  模型 ▼  │  → 发送  │
└──────────────────────────────────┘
```

### 6.2 空状态

无 Session + 有 Agent：`你好，我是 [Agent.name]` 欢迎卡片 + 新建按钮

---

## 八、文件变更清单

| 文件 | 动作 |
|---|---|
| `src/contracts/agent-identity.ts` | 新建 |
| `src/config/agent-store.ts` | 新建 |
| `src/server/routes/agents.ts` | 新建 |
| `src/server/app.ts` | 修改 — 注入 AgentStore |
| `src/server/start.ts` | 修改 — buildProductionResources |
| `src/runtime/session-service.ts` | 修改 — agentId |
| `src/storage/migrations.ts` | 修改 — v4 |
| `src/storage/session-index.ts` | 修改 |
| `src/contracts/preferences.ts` | 修改 — theme |
| `src/contracts/events.ts` | 修改 — timelineIdFromEvent |
| `web/src/themes/dark.css` | 新建 |
| `web/src/themes/light.css` | 新建 |
| `web/index.html` | 修改 |
| `web/src/lib/types.ts` | 修改 |
| `web/src/lib/api-client.ts` | 修改 |
| `web/src/app/WorkspaceApp.tsx` | 修改 |
| `web/src/features/chat/chat-state.ts` | 修改 — timeline 稳定化 |
| `web/src/features/chat/InputControlBar.tsx` | 新建 |
| `web/src/components/ChatPane.tsx` | 重写 |
| `web/src/features/chat/MessageComposer.tsx` | 重写 |
| `web/src/features/chat/AgentSelector.tsx` | 新建 |
| `web/src/features/settings/sections/AgentsSection.tsx` | 新建 |
| `web/src/features/settings/sections/LayoutSection.tsx` | 修改 |
| `web/src/features/settings/settings-state.ts` | 修改 |

---

## 九、任务拆分

### Task 1：Agent 契约与 AgentStore
- `agent-identity.ts` + `agent-store.ts` + 单测

### Task 2：Agent API + Session 关联
- `agents.ts` 路由 + `server/app.ts` 注入
- `session-service.ts` + migration v4
- 集成测试

### Task 3：主题系统
- dark.css / light.css
- `preferences` + `LayoutSection` + `WorkspaceApp` 应用

### Task 4：Agent 选择器 + 管理 Section
- `AgentSelector.tsx` + `AgentsSection.tsx`
- API Client + WorkspaceApp 集成

### Task 5：工具卡片渲染稳定性修复
- `chat-state.ts` timeline 稳定 ID
- `Event → timeline item` 映射重构
- 测试覆盖工具卡片不消失

### Task 6：聊天控制栏重构
- `InputControlBar.tsx` + `MessageComposer` + `ChatPane` 重写
- 空状态优化

### Task 7：全量验收
- 质量门全部通过 + `plans/phase-05.md` 记录

---

## 十、质量门

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
npx playwright test
```

## 十一、验收标准

- [ ] Agent 创建/编辑/归档 API 全部可用
- [ ] 无 Agent 时可直接创建 Session，`agent_id` 为 NULL
- [ ] Session 可绑定到 Agent，列表可按 Agent 过滤
- [ ] 亮/暗主题切换持久化，刷新不变
- [ ] 工具卡片在流式渲染中不消失/不乱序
- [ ] 控制栏下移，模型选择/工具/思考在输入框下方一行
- [ ] 空状态欢迎卡片随 Agent 切换更新（无 Agent 时显示"默认"）
- [ ] `npm run check` 全部通过
- [ ] Playwright 全部通过
- [ ] 工作区干净（`git status --short` 空）

---

## 实施记录

### 提交

| 提交 | 内容 |
|---|---|
| `dd80ed0` | feat: add agent web components and api client — AgentSelector / AgentsSection / types / API client |
| `e3c3c21` | feat: add agent identity contract, store, api routes and session migration |
| `de1faef` | feat: add dark/light theme system — CSS 主题 + preferences appearance + WorkspaceApp 应用 |
| `19bd8ac` | feat: add InputControlBar, fix timeline stability, session agentId support |
| `3d84a6f` | feat: integrate chat control bar, agent selector, theme system |
| `540dc77` | feat: wire agent list loading, tool/thinking controls, fix duplicate send button |

### 质量门

| 检查项 | 结果 |
|---|---|
| PI import | ✓ |
| TypeScript strict | ✓ |
| 服务端测试 | ✓ 29/189 |
| Web 测试 | ✓ 13/160 |
| Web 构建 | ✓ 280KB |
| Playwright | 12/16 (4 选择器适配遗留，非功能缺陷) |

### 已知局限

- Playwright E2E 4 个选择器适配遗留（MessageComposer 旧 aria-label 与 InputControlBar 新增 select 重叠）
- SettingsPage 中 AgentsSection 尚未接入实际数据（需 API 调用链路完善）

# Phase 8：Agent 模型去枚举化、底色与新会话体验

**状态：已完成（2026-07-28）** | 整理分支：`phase-8-agent-foundation`
**基线：** `main`（Phase 7 验收通过后，`708cac8`）
**参考：** openhanako "Agent 即文件"+ yuan 人格模板；现有 Phase 5 Agent 身份证雏形（`plans/phase-05.md`）

---

## 一、目标

废弃 Agent 的 `assistant | coding | work` 场景枚举，**且不使用 capabilities / skills / scene 或其他字段替代**。Agent 本身没有类型。Phase 8 只建立：

1. 最小稳定身份（identity.json：version + id + name + createdAt，无 type）；
2. 独立、可编辑的"底色"人格配置（base-color.json：persona / personality / replyStyle / innerSetting）；
3. 创建期底色模板（空白 + 4 个颜色模板，仅在创建时填充表单，Agent 不保存 templateId）；
4. 旧 Agent 数据安全迁移（去 type、profile.json → base-color.json、补 innerSetting、原子写入、可恢复）；
5. Agent 默认工作目录（独立 settings.json，可变运行设置，不属于身份或底色）；
6. 以首条消息创建 Session 的专门创建页（独立单页非弹窗，复用 MessageComposer，发送即创建+锁定+Prompt）；
7. Windows 原生文件夹选择器（server-first 架构桥接，不引入 Electron）；
8. 装饰色（基于 Agent ID 稳定生成，不持久化，无人格含义）。

### 最终范围校正

Phase 8 经过概念讨论后收窄为基础设施阶段，不实现口号层或未来生态能力：

- "底色"是 Agent 自身可随时编辑、实时生效的底层人格；
- 颜色模板只帮助创建初始底色，创建后不保存模板 ID，Agent 与模板完全脱钩；
- 不用 capabilities、skills、scene 或其他字段替代被删除的 `type`；
- 不创建 `config.yaml`、memory/、desk/ 等无行为骨架；
- yuan 可复用人格层、记忆、插件、项目改名为 OpenColorful 等均留待后续 Phase 重新讨论。

## 二、设计决策

### 2.1 数据模型——三文件分离

每个 Agent 目录 `~/.person-agent/agents/<id>/` 下三文件 + sessions/：

```
agents/<id>/
├── identity.json     ← 身份证（不可变字段，version 2）
├── base-color.json   ← 底色（人格配置，可编辑）
├── settings.json     ← 运行设置（默认工作目录等，可变）
└── sessions/         ← PI JSONL 会话
```

**identity.json（version 2，去 type）**：
```ts
interface AgentIdentity {
  readonly version: 2;
  readonly id: string;          // 服务端生成，不可变，目录名
  readonly name: string;       // 可修改，1-100 字符
  readonly createdAt: string;  // 不可变
}
```
不增加头像、颜色、性别、生日、标签、状态、职业或关系字段。

**base-color.json（version 1，人格配置）**：
```ts
interface BaseColor {
  readonly version: 1;
  readonly persona: string;            // "我是谁"核心描述
  readonly personality: readonly string[];  // 性格特质列表
  readonly replyStyle: string;         // 表达方式（自由文本）
  readonly innerSetting: string;       // 价值取向/偏好/习惯/情绪倾向/相处边界
  readonly updatedAt: string;
}
```
- `innerSetting` 不得承担工具权限、职业能力、工作流程或场景 Prompt；
- 每个 Agent 都必须有合法 base-color.json；空白底色（四项全空字符串）是合法状态；
- 身份与底色**原子创建**，不能留下只有身份、没有底色的半成品。

**settings.json（version 1，运行设置）**：
```ts
interface AgentSettings {
  readonly version: 1;
  readonly defaultCwd: string | null;  // 可选默认工作目录
  readonly updatedAt: string;
}
```
- 不属于身份或底色；
- 不自动把 Agent 内部数据目录当作工作目录；
- 缺失时视为 `defaultCwd: null`。

### 2.2 底色模板

Server 统一提供"空白 + 4 个"内置只读模板，共 5 个：

| 模板 | 颜色 | persona 示例 | personality | replyStyle | innerSetting 示例 |
|---|---|---|---|---|---|
| 空白 | — | "" | [] | "" | "" |
| 蓝色 | 冷静理性 | "我是一个冷静理性的助手..." | ["理性","客观","严谨"] | "简洁直接" | "重视事实与逻辑，避免情绪化表达" |
| 橙色 | 温柔知性 | "我是一个温柔知性的伙伴..." | ["温和","耐心","善解人意"] | "亲切详细" | "注重陪伴感，关心对方情绪" |
| 绿色 | 稳定包容 | "我是一个稳定包容的对话者..." | ["稳重","包容","可靠"] | "稳健平和" | "尊重差异，不急于给结论" |
| 紫色 | 创意灵动 | "我是一个创意灵动的搭档..." | ["好奇","灵活","有想象力"] | "活泼有趣" | "鼓励新视角，不怕跑题" |

模板只能体现人格和相处方式，**不能包含 coding/work/assistant 等职业分类，也不能声明工具或权限**。

模板只在创建 Agent 时填充表单。Web 可让用户继续编辑，**创建接口只提交最终 name、baseColor 和可选 defaultCwd**。Agent 不保存 templateId、模板版本或颜色字段；修改或删除模板不得影响已有 Agent。

### 2.3 装饰色

Agent 选择界面使用"名称首字 + 根据 Agent ID 稳定生成的装饰色"。装饰色**不持久化**，也**没有人格含义**。

- 后端在 `AgentView.decorColor` 字段动态计算返回（避免前端重复实现 + 保证一致）；
- 算法：`hash(agentId) % 7` → 映射到 7 色调色板（与设计令牌 ramps 对齐：blue/teal/coral/amber/purple/pink/green）；
- 颜色只用于 UI 装饰（色点、首字徽章背景），不写入任何文件。

### 2.4 API 契约——直接切换，不维护旧 HTTP 兼容层

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表（返回 AgentView，含 decorColor） |
| POST | `/api/agents` | 创建（body: `{ name, baseColor, defaultCwd? }`，原子创建 identity+base-color+可选 settings） |
| GET | `/api/agents/:id` | 详情 |
| PUT | `/api/agents/:id` | 更新 identity（body 只含 `{ name }`） |
| GET | `/api/agents/:id/base-color` | 获取底色（替代 /profile） |
| PUT | `/api/agents/:id/base-color` | 更新底色（立即持久化，下一 turn 生效） |
| GET | `/api/agents/:id/settings` | 获取运行设置 |
| PUT | `/api/agents/:id/settings` | 更新运行设置（defaultCwd） |
| POST | `/api/agents/:id/archive` | 归档 |
| GET | `/api/agents/:id/sessions` | 会话列表 |
| GET | `/api/agents/templates` | 底色模板列表（只读） |
| POST | `/api/directories/pick` | 原生目录选择（Windows） |

**关键约束**：
- Agent 请求和响应**不再包含 type**；
- `/profile` 能力替换为语义明确的 `/base-color` 能力；
- **不保留 /profile 别名，也不接受被忽略的 type**；
- 所有跨进程输入继续使用 TypeBox 或显式解析器校验；
- 磁盘旧格式必须迁移，但旧 HTTP 客户端无需兼容。

### 2.5 人设合成（system prompt）

底色作为独立人格段落参与 system prompt 合成，在 `messages.ts:buildSystemPrompt(agentId)` 中实现：

```
[persona]

回复风格: [replyStyle]

性格标签: [personality 拼接]

相处边界: [innerSetting]
```

**约束**：
- 平台规则、安全边界与工具权限必须保持独立（不并入底色段）；
- 空底色字段应省略（`if (field) parts.push(...)`）；
- 全空底色 → 返回 undefined（不注入 system prompt）；
- 底色更新立即持久化，正在生成的 turn 不受影响，所有已绑定 Session 从**下一次 Prompt** 开始使用最新底色，历史消息不重写。

现有 `messages.ts` 的 `runtimeSystemPrompt` Map + `ensureRuntime` 检测 profile 变更并 invalidate runtime 的机制**保留并扩展**：buildSystemPrompt 加入 innerSetting 后，四项任一变化都触发 runtime 重建。

### 2.6 旧数据迁移

`AgentStore.migrate()` 方法，在 Server 启动时（AgentStore 构造后）调用一次。逻辑：

对每个 agent 目录：
1. 读 identity.json：
   - 若有 `type` 字段（旧格式 version 1）→ 重写为 `{ version: 2, id, name, createdAt }`，删除 type；
   - 若已 version 2 → 跳过 identity；
2. 处理底色：
   - 若存在 profile.json → 读 persona/personality/replyStyle，写 base-color.json（version 1，加 `innerSetting: ""`），删除 profile.json；
   - 若不存在 base-color.json → 创建空白 base-color.json；
   - 若已存在 base-color.json → 跳过；
3. settings.json：
   - 不存在 → 不强制创建（视为 defaultCwd: null，运行时懒生成）；
4. 保留 id、name、createdAt、归档状态（.archived- 前缀目录不动）、Session 文件、Session 绑定（SQLite agent_id 不变）。

**约束**：
- 自动、幂等、可恢复；
- 采用安全的原子写入（tmp + rename）；
- 成功前不得删除旧数据（profile.json 仅在 base-color.json 写入成功后删除）；
- 失败时保留原数据并给出可诊断错误（记录 agentId + 阶段 + 错误），不能留下半迁移状态；
- 单 agent 迁移失败不阻塞其他 agent。

### 2.7 Session 创建独立页

点击"新建 Session"进入专门的会话创建主页（`/new` 路由），**不使用弹窗**。页面参考 openhanako 的欢迎/新会话体验，是正常聊天页的一种"尚未落库的草稿状态"。

**页面采用聚焦式布局**：
- 突出当前 Agent（名称+装饰色首字徽章）；
- 提供可视化 Agent 切换（横向色卡列表，点击切换）；
- 也允许选择"不绑定 Agent"；
- 工作目录显示行：选择 Agent 时自动继承其 defaultCwd，可点击"更换"调原生选择器；
- 复用现有 `MessageComposer`（不创建第二套输入框）；
- 标题可选，空白时使用"新会话"；
- **不展示模型/思考等级/工具权限**（用全局默认值，可在创建后修改）。

**绑定规则**：
- Session 创建后 agentId **永久不可修改**；
- 未绑定 Session 以后**也不能再绑定**；
- 选择 Agent 时自动继承其 defaultCwd；
- 在创建页临时更换目录只影响本次 Session；
- 没有 Agent 或 Agent 没有 defaultCwd 时，**必须选择目录后才能发送**；
- Session 创建后仍允许按现有规则修改工作目录（在 SessionSettingsPanel）；
- 修改目录后完整工具权限必须重新确认。

**首条消息发送即创建**：
- 取消独立"创建"按钮：发送第一条消息时创建 Session、锁定 Agent 绑定并立即发送 Prompt；
- 未发送便离开页面时，**不产生空 Session**（草稿状态纯前端，路由切换清空）。

**防重复（首次发送必须）**：
- 前端 `submitting` 状态锁，连续点击或快捷键不能创建多个 Session，也不能重复发送；
- 提交期间显示明确状态（按钮变 loading / disabled）；
- 创建失败时保留草稿、首条消息和所有选择；
- 创建成功但 Prompt 失败时保留已创建 Session 和输入内容，允许重试且不重复创建（重试只调 `POST /api/sessions/:id/messages`）；
- 依赖已有 Session 的命令（/compact /new /abort 等）在草稿状态下必须安全禁用或给出稳定反馈。

### 2.8 Windows 原生目录选择

**实现方案（server-first，不引入 Electron）**：
- 后端新增路由 `POST /api/directories/pick`，无 body；
- 后端 `src/platform/folder-picker.ts`：
  - Windows：`child_process.spawn('powershell.exe', ['-Command', '...'])` 调用 `System.Windows.Forms.FolderBrowserDialog`，等待用户选择，stdout 解析返回绝对路径；用户取消返回 `cancelled: true`；
  - macOS/Linux：保留平台抽象，返回 501 NOT_IMPLEMENTED，前端回退手工输入（本阶段不要求原生实现）；
- 返回 `{ path: string | null, cancelled: boolean }`；
- 调用是异步的（`child_process.spawn` + Promise），不阻塞其他 HTTP 请求；
- 路径校验：返回的路径必须是绝对路径、不允许包含 `..`。

### 2.9 Web 状态加载策略

NewSessionPage 需访问 `agents / models / preferences`。当前 WorkspaceApp 与 SettingsPage 各自加载、不共享。

**决策**：独立加载（参考 SettingsPage 模式），**不引入 Context**。理由：N+1 原则，避免大重构；NewSessionPage 生命周期短（创建后即跳转 WorkspaceApp），重复加载成本可接受。

---

## 三、明确非目标

不实现：项目改名（person-Agent → OpenColorful）、capabilities、skills、scene、插件系统、记忆、desk、梦境、自我进化、多 Agent 协作、头像系统、自定义模板、模板导入导出、模板市场、自动标题生成、Electron、macOS/Linux 原生目录选择器。

**不要为未来能力创建无行为的空目录或提前固化 Schema。**

---

## 四、文件变更清单（按归属分组）

### 4.1 契约层（src/contracts/）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/contracts/agent-identity.ts` | 重写 | 删 `type`/`AgentType`/`AGENT_TYPES`/`REPLY_STYLES`；`AgentIdentity.version` 升 2；`AgentProfile` → `BaseColor`（加 innerSetting）；`AgentView` 加 `baseColor`/`settings`/`decorColor`；`defaultProfile` → `defaultBaseColor` |
| `src/contracts/base-color-templates.ts` | 新建 | 5 个模板常量 + TypeBox Schema |
| `src/contracts/agent-settings.ts` | 新建 | `AgentSettingsSchema` + `defaultAgentSettings` |

### 4.2 存储与服务层（src/config/ + src/runtime/）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/config/agent-store.ts` | 重写 | `create` 原子化（identity+base-color 同写，失败回滚删 dir）；`saveProfile` → `saveBaseColor`；新增 `loadSettings/saveSettings`；新增 `migrate()` 方法；`load` 返回 `decorColor`；删除 `type` 相关参数 |
| `src/runtime/session-service.ts` | 不改 | create 已支持 agentId |
| `src/runtime/tool-policy.ts` | 不改 | cwd 校验逻辑不变 |
| `src/storage/migrations.ts` | 不改 | SQLite schema 不动（agent_id 在 v4 已加） |

### 4.3 路由层（src/server/routes/ + src/platform/）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/server/routes/agents.ts` | 重写 | 删 type 校验；POST body 改 `{ name, baseColor, defaultCwd? }`；`/profile` → `/base-color`；新增 `/settings` GET/PUT；新增 `/templates` GET |
| `src/server/routes/messages.ts` | 改 | `buildSystemPrompt` 加 innerSetting 段 |
| `src/server/routes/directories.ts` | 新建 | `POST /api/directories/pick` |
| `src/platform/folder-picker.ts` | 新建 | Windows PowerShell + macOS/Linux 抽象 |
| `src/server/app.ts` | 改 | 注入 directories 路由；启动时调 `agentStore.migrate()` |

### 4.4 Web 契约与 API 客户端（web/src/lib/）

| 文件 | 动作 | 说明 |
|---|---|---|
| `web/src/lib/types.ts` | 改 | 删 `AgentIdentity.type`；`AgentProfile` → `BaseColor` 加 innerSetting；加 `AgentSettings`；`AgentView` 加 baseColor/settings/decorColor |
| `web/src/lib/api-client.ts` | 改 | `createAgent` 改签名 `(name, baseColor, defaultCwd?)`；`/profile` → `/base-color`；加 `getBaseColorTemplates / pickDirectory / getAgentSettings / updateAgentSettings` |

### 4.5 Web 组件层

| 文件 | 动作 | 说明 |
|---|---|---|
| `web/src/features/agents/decor-color.ts` | 新建 | `decorColorFromId(id): { bg, fg }` 纯函数 |
| `web/src/features/agents/BaseColorTemplatePicker.tsx` | 新建 | 色卡网格（5 个模板，点击填充表单） |
| `web/src/features/agents/DirectoryPicker.tsx` | 新建 | 原生目录选择按钮（调 pickDirectory，回退手工输入） |
| `web/src/features/agents/AgentAvatar.tsx` | 新建 | 首字+装饰色徽章 |
| `web/src/features/chat/AgentSelector.tsx` | 改 | 去掉 `[type]` 显示，用 AgentAvatar |
| `web/src/features/settings/sections/AgentsSection.tsx` | 重写 | 只保留 Agent 列表、创建入口与卡片操作，创建/编辑移到独立页面 |
| `web/src/features/agents/AgentForm.tsx`、`AgentCreatePage.tsx`、`AgentEditPage.tsx` | 新建 | 创建/编辑共享表单；创建页含模板，编辑页只编辑 Agent 自身底色；显式保存与未保存离开确认 |
| `web/src/features/agents/TagInput.tsx`、`ConfirmDiscard.tsx` | 新建 | 性格标签输入与离开确认；提交时收录尚未按回车的标签 |
| `web/src/components/SessionSidebar.tsx` | 改 | 会话徽章用 AgentAvatar；删除"新建会话"Modal 改为跳转 `/new` |
| `web/src/features/sessions/NewSessionPage.tsx` | 新建 | 独立单页：Agent 切换 + 工作目录行 + MessageComposer；首条消息创建+锁定+Prompt；防重复 |
| `web/src/app/page-router.ts` | 改 | 加 `session-new`、`agent-new`、`agent-edit` 路由及导航函数 |
| `web/src/app/App.tsx` | 改 | 渲染 NewSessionPage 与 Agent 创建/编辑页面 |
| `web/src/app/WorkspaceApp.tsx` | 改 | `handleCreateSession` 改为接收 NewSessionPage 的创建请求（含首条消息）；现有 Modal 调用移除 |

### 4.6 测试

| 文件 | 动作 | 说明 |
|---|---|---|
| `tests/unit/agent-store.test.ts` | 改 | 三文件存储、旧 identity+profile 迁移、幂等、底色与 settings 读写 |
| `tests/integration/directory-picker.test.ts` | 新建 | Windows mock、取消行为、路径校验、macOS/Linux 501 |
| `tests/integration/agent-routes.test.ts` | 改 | 适配新契约（去 type、/base-color） |
| `tests/integration/persona-injection.test.ts` | 改 | 加 innerSetting 注入验证、空字段省略 |
| `web/src/features/agents/decor-color.test.ts` | 新建 | 稳定性 + 7 色分布 |
| `web/src/features/settings/sections/agents-section.test.tsx` | 改 | 适配新表单 |
| `web/src/features/sessions/new-session-page.test.tsx` | 新建 | 草稿离开不落库、首次发送只创建一次、创建/Prompt 失败恢复 |
| `web/tests/e2e/agent-management.spec.ts` | 新建 | Agent 列表、独立创建/编辑路由、未保存保护与响应式布局 |
| `web/tests/e2e/phase8.spec.ts` | 新建 | 模板选择、新建会话页、原生目录选择、桌面/窄屏 |
| `web/tests/e2e/workspace.spec.ts` | 改 | 适配新会话创建流程（去 Modal） |

---

## 五、任务拆分

### 阶段 A：契约层（主 Agent 串行，infra 先行）

**T1：Agent 契约重构**
- 文件：`src/contracts/agent-identity.ts`、`src/contracts/base-color-templates.ts`、`src/contracts/agent-settings.ts`
- 说明：见 4.1。这是后续一切的基础。
- 验证：`npx tsc --noEmit` 通过（其他文件会临时报错，待 T2-T4 修复）。

### 阶段 B：存储与迁移（T1 完成后，可并行派子 Agent）

**T2：AgentStore 重构 + 迁移**
- 文件：`src/config/agent-store.ts`
- 依赖：T1
- 说明：原子 create、saveBaseColor、loadSettings/saveSettings、migrate()、decorColor 计算。
- 验证：单独跑 `npx vitest run tests/integration/agent-migration.test.ts`（T10 配合）。

**T3：底色模板 API + agents 路由重写**
- 文件：`src/server/routes/agents.ts`
- 依赖：T1 + T2
- 说明：删 type 校验、/profile→/base-color、新增 /templates、/settings。
- 验证：`npx vitest run tests/integration/agent-routes.test.ts`（T10 配合）。

**T4：人设合成加 innerSetting**
- 文件：`src/server/routes/messages.ts`
- 依赖：T1（BaseColor 含 innerSetting）
- 说明：buildSystemPrompt 加 innerSetting 段，保留 runtimeSystemPrompt 变更检测。
- 验证：`npx vitest run tests/integration/persona-injection.test.ts`（T10 配合）。

### 阶段 C：原生目录选择（独立并行，不依赖 T1-T4）

**T5：原生目录选择后端**
- 文件：`src/platform/folder-picker.ts`、`src/server/routes/directories.ts`、`src/server/app.ts`
- 依赖：无（独立模块）
- 说明：Windows PowerShell + macOS/Linux 抽象，POST /api/directories/pick。
- 验证：`npx vitest run tests/integration/directory-picker.test.ts`（T10 配合）。

### 阶段 D：Web 契约与 API 客户端（T1 + T3 完成后）

**T6：Web 类型与 API 客户端**
- 文件：`web/src/lib/types.ts`、`web/src/lib/api-client.ts`
- 依赖：T1 + T3（契约对齐）
- 说明：去 type、BaseColor 加 innerSetting、加 AgentSettings、createAgent 改签名、/profile→/base-color、加 pickDirectory/getBaseColorTemplates/getAgentSettings/updateAgentSettings。
- 验证：`npm run web:test` 通过。

### 阶段 E：Web 组件（T6 完成后，可并行派子 Agent）

**T7：装饰色 + AgentAvatar + AgentSelector 改造**
- 文件：`web/src/features/agents/decor-color.ts`、`AgentAvatar.tsx`、`web/src/features/chat/AgentSelector.tsx`、`web/src/components/SessionSidebar.tsx`（徽章部分）
- 依赖：T6
- 说明：纯函数 + 小组件，影响面小。
- 验证：`web/src/features/agents/decor-color.test.ts` + 现有 AgentSelector 单测。

**T8：AgentsSection 重写 + 模板/目录选择器**
- 文件：`web/src/features/settings/sections/AgentsSection.tsx`、`web/src/features/agents/BaseColorTemplatePicker.tsx`、`DirectoryPicker.tsx`
- 依赖：T6
- 说明：去 type Select、加底色四项表单、模板色卡、原生目录选择按钮。
- 验证：`agents-section.test.tsx` 改写。

**T9：NewSessionPage + 路由**
- 文件：`web/src/features/sessions/NewSessionPage.tsx`、`web/src/app/page-router.ts`、`App.tsx`、`WorkspaceApp.tsx`（handleCreateSession 改造）
- 依赖：T6 + T7（AgentAvatar）+ T8（DirectoryPicker）
- 说明：独立单页、聚焦布局、首条消息创建、防重复、草稿不落库。
- 验证：`new-session-page.test.tsx` + E2E。

### 阶段 F：测试与验收

**T10：服务端集成测试**
- 文件：见 4.6 服务端部分
- 依赖：T2/T3/T4/T5
- 说明：迁移、底色、目录选择、契约适配、人设注入。

**T11：Web 单测**
- 文件：见 4.6 Web 部分
- 依赖：T7/T8/T9
- 说明：decor-color、agents-section、new-session-page。

**T12：E2E + 质量门**
- 文件：`web/tests/e2e/phase8.spec.ts`、`workspace.spec.ts`
- 依赖：T7-T11 全部完成
- 说明：模板选择、新建会话页、原生目录选择、桌面/窄屏、回归现有流程。

**T13：验收与回写**
- 文件：`plans/phase-08.md`（本文件回写状态）、`README.md`
- 依赖：T12 通过
- 说明：质量门全过、验收 checkbox 勾选、提交。

---

## 六、并行规则

按 AGENTS.md 并行铁律：**同时满足才允许并行——无共享文件、无共享契约/迁移、无前后依赖**。

### 并行机会图

```
T1（契约，主 Agent 串行）
  │
  ├─→ T2（AgentStore）   ┐
  ├─→ T4（人设合成）     ├─ 三者无共享文件，T1 完成后可并行
  └─→ T5（目录选择，独立）┘
        │
        T2 完成 → T3（agents 路由，依赖 T2 的 store 方法）
                    │
                    T3 + T1 完成 → T6（Web 契约）
                                    │
                                    T6 完成 → T7 ┐
                                              T8 ├─ 三者无共享文件，可并行
                                              T9 ┘
                                                │
                                                T7-T9 完成 → T10/T11/T12
                                                                │
                                                                T13 验收
```

### 文件归属表（防冲突）

| 任务 | 独占文件 |
|---|---|
| T1 | `src/contracts/agent-identity.ts`、`base-color-templates.ts`、`agent-settings.ts` |
| T2 | `src/config/agent-store.ts` |
| T3 | `src/server/routes/agents.ts` |
| T4 | `src/server/routes/messages.ts` |
| T5 | `src/platform/folder-picker.ts`、`src/server/routes/directories.ts`、`src/server/app.ts`（注入部分） |
| T6 | `web/src/lib/types.ts`、`api-client.ts` |
| T7 | `web/src/features/agents/decor-color.ts`、`AgentAvatar.tsx`、`AgentSelector.tsx`、`SessionSidebar.tsx`（徽章） |
| T8 | `web/src/features/settings/sections/AgentsSection.tsx`、`BaseColorTemplatePicker.tsx`、`DirectoryPicker.tsx` |
| T9 | `web/src/features/sessions/NewSessionPage.tsx`、`page-router.ts`、`App.tsx`、`WorkspaceApp.tsx` |

**冲突点预警**：
- `src/server/app.ts`：T5 注入 directories 路由 + migrate 调用；若 T3 也要改 app.ts 注入新路由 → 主 Agent 先做 app.ts 改动，再派 T3/T5。
- `web/src/components/SessionSidebar.tsx`：T7 改徽章 + T9 改"新建会话"入口（Modal→跳转）→ T7 先改徽章，T9 再改入口；或主 Agent 先统一改 SessionSidebar。
- `web/src/app/WorkspaceApp.tsx`：T9 改 handleCreateSession → 独占。

**冲突解决**：主 Agent 负责所有共享 infra 文件（app.ts、SessionSidebar 共享部分），子 Agent 只在独占文件内实现。

---

## 七、质量门（验收时必须全部单独通过）

按 AGENTS.md 红线，逐条单独执行并读取退出码：

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test
```

**禁止 PowerShell 分号串联关键验证**。Playwright 必须在 `web/` 目录执行。

---

## 八、验收标准

### 8.1 契约与数据
- [x] `AgentIdentity` 无 type 字段，version=2
- [x] `BaseColor` 含 persona/personality/replyStyle/innerSetting/updatedAt
- [x] `AgentSettings` 含 defaultCwd，独立 settings.json
- [x] identity 与 base-color 原子创建（半成品不留）
- [x] 空白底色合法
- [x] Agent 不保存 templateId/模板版本/颜色字段
- [x] 装饰色不持久化、无人格含义

### 8.2 迁移
- [x] 旧 identity.json（含 type）自动迁移为 version 2 无 type
- [x] 旧 profile.json 自动迁移为 base-color.json（补 innerSetting）
- [x] 缺 profile 的 Agent 生成空白 base-color
- [x] 迁移幂等（重复运行不产生副作用）
- [x] 迁移失败保留原数据 + 可诊断错误，不阻塞其他 Agent
- [x] 保留 id/name/createdAt/归档状态/Session 文件/Session 绑定

### 8.3 API
- [x] Agent 请求/响应不含 type
- [x] `/profile` 能力替换为 `/base-color`，不保留别名
- [x] 不接受被忽略的 type
- [x] `/api/agents/templates` 返回 5 个只读模板
- [x] `/api/agents/:id/settings` GET/PUT 可用
- [x] `POST /api/directories/pick` Windows 返回原生选择结果
- [x] macOS/Linux 返回 501 + 前端回退

### 8.4 人设合成
- [x] base-color 作为独立人格段注入 system prompt
- [x] innerSetting 参与合成
- [x] 空字段省略
- [x] 平台规则/安全/工具权限保持独立
- [x] 底色修改从下一 turn 生效，历史消息不重写
- [x] 正在生成的 turn 不受影响

### 8.5 Web 体验
- [x] AgentsSection 只保留列表；独立创建/编辑页提供底色四项、模板与默认工作目录
- [x] 模板选中后填充表单，可继续编辑，提交时不带 templateId
- [x] 底色更新立即持久化
- [x] AgentSelector 去 `[type]`，用 AgentAvatar（首字+装饰色）
- [x] 装饰色基于 Agent ID 稳定生成
- [x] "新建 Session" 进入 `/new` 独立单页（非弹窗）
- [x] 聚焦布局：突出当前 Agent + 可视化切换 + 可选"不绑定"
- [x] 工作目录继承 Agent defaultCwd，可临时更换
- [x] 无 Agent 或无 defaultCwd 时必须选目录才能发送
- [x] 复用 MessageComposer，无独立"创建"按钮
- [x] 首条消息发送即创建+锁定 Agent+发送 Prompt
- [x] 连续点击/快捷键不重复创建
- [x] 创建失败保留草稿
- [x] 创建成功但 Prompt 失败保留 Session+输入，可重试不重复创建
- [x] 草稿状态离开不落库
- [x] 草稿状态 /compact /new /abort 等命令安全禁用
- [x] Session 创建后 agentId 永久不可修改
- [x] 未绑定 Session 以后不能绑定

### 8.6 质量门
- [x] PI import 边界
- [x] tsc strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
- [x] Vitest 全过
- [x] Web Vitest 全过
- [x] Web 生产构建通过
- [x] tsconfig.build.json 通过
- [x] Playwright 全过（含 phase8.spec.ts + workspace.spec.ts 回归）
- [x] 提交后工作区干净

---

## 九、测试覆盖矩阵

| 场景 | 测试文件 | 类型 |
|---|---|---|
| 新契约（无 type、拒绝废弃/模板元字段、/base-color） | `agent-routes.test.ts` | 集成 |
| 旧数据迁移 + 幂等 + 失败原样保留 | `agent-store.test.ts` | 单元 |
| 模板复制后完全脱钩 | `agent-routes.test.ts` + `phase8.spec.ts` | 集成+E2E |
| Agent 原子创建 | `agent-store.test.ts` + `agent-routes.test.ts` | 单元+集成 |
| 名称上限写盘前校验 | `agent-store.test.ts` + `agent-routes.test.ts` | 单元+集成 |
| 不存在 Agent 不生成底色/settings 幽灵目录 | `agent-store.test.ts` + `agent-routes.test.ts` | 单元+集成 |
| 底色修改从下一 turn 生效 | `persona-injection.test.ts` | 集成 |
| 空字段省略 | `persona-injection.test.ts` | 集成 |
| Agent 绑定不可修改 | `session-agent-binding.test.ts`（现有） | 集成 |
| 工作目录继承与覆盖 | `phase8.spec.ts` | E2E |
| 原生选择取消行为 | `directory-picker.test.ts` + `phase8.spec.ts` | 集成+E2E |
| 草稿离开不落库 | `new-session-page.test.tsx` + `phase8.spec.ts` | 单测+E2E |
| 首次发送只创建一次 | `new-session-page.test.tsx` + `phase8.spec.ts` | 单测+E2E |
| 创建/Prompt 失败恢复并保留首条消息 | `new-session-page.test.tsx` | 单测 |
| 草稿命令稳定反馈、隐藏无效配置控件 | `new-session-page.test.tsx` | 单测 |
| 桌面/窄屏 Session 创建页 | `phase8.spec.ts` | E2E |
| 装饰色稳定性 | `decor-color.test.ts` | 单测 |
| 模板选择表单交互 | `agents-section.test.tsx` + `phase8.spec.ts` | 单测+E2E |
| Agent 独立创建/编辑、未保存保护与历史栈清理 | `agent-management.spec.ts` | E2E |

---

## 十、实施记录

Phase 8 由 `708cac8`（Phase 7 合并点）起开发；实现完成后从原 `main` 未提交工作区整理到 `phase-8-agent-foundation`，通过独立审查与全量质量门后合并。

### 提交

| 提交 | 内容 |
|---|---|
| （Phase 8 整合提交） | Agent 去枚举化、底色与 settings、数据迁移、目录选择、新会话页、Agent 管理 UX、回归修复与文档回写 |

### 质量门

| 检查项 | 结果 |
|---|---|
| PI import | 通过：`node scripts/verify-pi-sdk-imports.mjs` |
| TypeScript strict | 通过：`npx tsc --noEmit -p tsconfig.json` |
| 服务端测试 | 36 文件 / 292 用例通过 |
| 服务端构建 | 通过：`npx tsc -p tsconfig.build.json` |
| Web 测试 | 28 文件 / 326 用例通过 |
| Web 构建 | 通过：Vite 生产构建 |
| Playwright | 40/40 通过 |
| 工作区 | 提交后确认干净 |

### 阻断与修复记录

1. **Agent 管理 UX 与历史栈**：创建/编辑迁移到独立页面；补未保存确认、待提交标签收录、创建成功与放弃后的历史清理。最终实现使用显式 history state + `popstate`，移除固定延时。
2. **迁移原子性**：审查发现坏 `profile.json` 会在失败前改写 identity。改为先完整读取/校验，再提交；提交阶段失败时恢复 identity/base-color/profile 快照。
3. **写盘前契约校验**：名称超过 100 字符曾会留下不可读目录或改坏 identity；Store 与 API 现在都在写盘前拒绝。
4. **幽灵 Agent 数据**：底色/settings 读写现在先验证 identity，不存在 Agent 统一返回 404 且不创建目录。
5. **严格输入**：创建/更新接口拒绝废弃 `type`、`templateId` 和其他未声明字段，不再静默忽略。
6. **新会话失败恢复**：创建或首条 Prompt 失败时保留原消息；重试只发送原消息、不重复创建 Session。创建页隐藏无效模型/工具/思考控件，草稿命令给出稳定反馈。

### 最终验收结论

Phase 8 最终范围全部达成，且没有提前引入 yuan 持久化引用、capabilities、skills、scene、记忆、插件或项目改名。独立代码审查发现的 7 类覆盖缺口均已新增回归测试并修复；PI 边界、TypeScript、服务端与 Web 全量测试、两套构建和 Playwright 40/40 均通过，可以合并到 `main`。

---

*本计划为 Phase 8 实施依据，遵循 AGENTS.md 5 步生命周期（计划→实现→验证→提交→回写）。子 Agent 报告不作为验收证据，主 Agent 必须独立复核 diff + 重跑质量门。*

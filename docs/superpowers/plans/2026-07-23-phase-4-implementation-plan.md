# Phase 4 交互体验与基础设施优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Phase 3 Web 工作台上增量实现独立设置中心、全局默认配置、可调宽侧栏、Focus 模式、可恢复日志诊断和低抖动流式渲染。

**Architecture:** 保留 Supervisor、Agent Server、ProviderStore、SessionService、SSE/WS 和 sequence cursor 作为现有事实源。服务端新增版本化 `preferences.json` 和设置路由；Web 将当前 App 拆为 `WorkspaceApp` 与 `/settings` 页面，流式事件在进入 reducer 前按帧批处理，消息继续用时间线投影正文、思考、工具、计划和附件。

**Tech Stack:** Node.js 22.19+、TypeScript、Hono、TypeBox、React 19、Vite、Vitest、Playwright、现有 lucide-react。

---

## 执行约束

- 每个任务先写失败测试，再写最小实现；任务完成后单独提交。
- 不改变 PI SDK import 边界，不复制 Provider、Session 或工具协议。
- 设置中心是同源 `/settings` 页面，不创建第二个 Web Bundle 或 Electron 窗口。
- 全局默认值只应用于新建 Session；Session 的显式覆盖值永远优先。
- 流式批处理只能改变 React 更新频率，不能改变事件顺序、sequence cursor、Resume 或 JSONL 持久化语义。

## 文件地图

**Server**

- `src/contracts/preferences.ts`：偏好文档 schema、类型、归一化和默认值。
- `src/config/preferences-store.ts`：版本化 JSON 文件读写、原子写入、损坏恢复。
- `src/server/routes/settings.ts`：全局偏好 API。
- `src/supervisor/log-filter.ts`：日志行解析、级别/关键词过滤和 cursor。
- `src/server/app.ts`、`src/server/start.ts`、`src/server/routes/sessions.ts`：依赖注入和新建 Session 应用默认值。
- `src/supervisor/app.ts`、`src/supervisor/process-controller.ts`：日志查询参数和诊断元数据。

**Web**

- `web/src/app/App.tsx`：只负责根据 pathname 选择页面。
- `web/src/app/WorkspaceApp.tsx`：现有三栏工作台和连接生命周期。
- `web/src/features/settings/*`：设置 shell、导航、section 和本地状态。
- `web/src/features/layout/use-panel-resize.ts`、`layout-preferences.ts`：面板尺寸、折叠和保存。
- `web/src/features/chat/stream-buffer.ts`：SSE/WS 事件按 session/stream 分桶、按帧 flush。
- `web/src/features/chat/chat-state.ts`、`MessageList.tsx`、`ChatPane.tsx`：批量事件、时间线和滚动体验。
- `web/src/lib/api-client.ts`、`web/src/lib/types.ts`：设置、日志和布局契约。

---

### Task 1: 全局偏好契约与持久化

**Files:**
- Create: `src/contracts/preferences.ts`
- Create: `src/config/preferences-store.ts`
- Test: `tests/unit/preferences.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/preferences.test.ts` 覆盖以下行为：

```ts
it("returns version 1 defaults when the file is missing");
it("normalizes unknown fields before validation");
it("clamps invalid layout widths to the documented ranges");
it("recovers from malformed JSON and writes a repaired document");
it("writes through a temporary file and leaves no temporary file after success");
```

使用 `makeTempHome()` 和 `getRuntimePaths()`，断言 `paths.preferences` 的内容只包含合法字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/preferences.test.ts`

Expected: FAIL because `PreferencesStore` and `PreferencesDocumentSchema` do not exist.

- [ ] **Step 3: 实现 schema、归一化和 store**

在 `src/contracts/preferences.ts` 定义：

```ts
export const PreferencesDocumentSchema = Type.Object({
  version: Type.Literal(1),
  defaults: Type.Object({
    model: Type.Union([Type.Object({ providerId: Type.String(), modelId: Type.String() }), Type.Null()]),
    thinkingLevel: Type.Union(THINKING_LEVELS.map(Type.Literal)),
    toolMode: Type.Union(TOOL_MODES.map(Type.Literal)),
  }),
  layout: Type.Object({
    leftSidebarWidth: Type.Number({ minimum: 200, maximum: 420 }),
    rightSidebarWidth: Type.Number({ minimum: 240, maximum: 520 }),
    leftCollapsed: Type.Boolean(),
    rightCollapsed: Type.Boolean(),
    focusMode: Type.Boolean(),
    reducedMotion: Type.Union([Type.Literal("system"), Type.Literal("on"), Type.Literal("off")]),
  }),
}, { additionalProperties: false });
```

导出 `defaultPreferences()`、`normalizePreferences(value: unknown)` 和 `PreferencesStore.get()/update(patch)`。读取先筛选已知字段并补默认值，再调用 `Value.Check`；写入使用 `${filePath}.${pid}.${timestamp}.tmp`，`renameSync` 原子替换。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/preferences.test.ts`

Expected: all preference tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src/contracts/preferences.ts src/config/preferences-store.ts tests/unit/preferences.test.ts
git commit -m "feat: add versioned preferences store"
```

### Task 2: 偏好 API 与新建 Session 默认值

**Files:**
- Create: `src/server/routes/settings.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/start.ts`
- Modify: `src/server/routes/sessions.ts`
- Test: `tests/integration/settings-routes.test.ts`, `tests/integration/session-settings.test.ts`

- [ ] **Step 1: 写失败测试**

在 `settings-routes.test.ts` 构造临时 `PreferencesStore`、`SessionService` 和 `ModelService`，断言：

```ts
it("GET /api/settings/preferences returns defaults and layout");
it("PUT /api/settings/preferences validates tool mode and model reference");
it("rejects an unavailable default model without changing the previous document");
it("does not expose credentials in the preferences response");
```

在 `session-settings.test.ts` 增加：

```ts
it("applies global defaults only when creating a new session");
it("keeps an existing session override after global defaults change");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/integration/settings-routes.test.ts tests/integration/session-settings.test.ts`

Expected: FAIL because `ServerAppOptions.preferencesStore` and `/api/settings/preferences` are absent.

- [ ] **Step 3: 接入路由和依赖注入**

在 `ServerAppOptions` 增加 `preferencesStore?: PreferencesStore`；`createServerApp` 在存在 store 时注册 `registerSettingsRoutes(app, store, modelService)`。生产资源在 `buildProductionResources()` 创建同一实例并在 `dispose()` 前停止使用。

`PUT` 只接受 `defaults` 和 `layout` patch；当 patch 含 model 时调用 `modelService.resolveModel(providerId, modelId)`，失败返回 `400 INVALID_INPUT`，不写文件。`GET` 返回已归一化文档。

新建 Session 时，在 `sessionService.create()` 后读取偏好：仅当请求没有同名字段时写入 `toolMode`、`thinkingLevel` 和默认 model；请求显式值优先。无效默认模型只返回可见 warning 字段，不阻塞创建。

- [ ] **Step 4: 运行服务端测试**

Run: `npx vitest run tests/integration/settings-routes.test.ts tests/integration/session-settings.test.ts`

Expected: all route and isolation tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/settings.ts src/server/app.ts src/server/start.ts src/server/routes/sessions.ts src/runtime/session-service.ts tests/integration/settings-routes.test.ts tests/integration/session-settings.test.ts
git commit -m "feat: expose global preferences and session defaults"
```

### Task 3: 日志查询与诊断契约

**Files:**
- Create: `src/supervisor/log-filter.ts`
- Modify: `src/supervisor/process-controller.ts`
- Modify: `src/supervisor/app.ts`
- Modify: `src/supervisor/types.ts`
- Test: `tests/unit/log-filter.test.ts`, `tests/integration/supervisor.test.ts`

- [ ] **Step 1: 写失败测试**

为日志行使用固定格式样本，覆盖：

```ts
it("filters by info/warn/error without matching substrings in messages");
it("returns only the requested tail line count");
it("returns a stable next cursor for incremental reads");
it("preserves redaction of sk keys and authorization headers");
```

扩展 Supervisor 集成测试，验证 `GET /api/supervisor/logs?limit=2&level=error` 的 `logs`, `truncated`, `nextCursor` 和 `status` 字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/log-filter.test.ts tests/integration/supervisor.test.ts`

Expected: FAIL because `readLogTail` does not accept query options and response lacks cursor metadata.

- [ ] **Step 3: 实现行过滤和查询参数**

定义：

```ts
export interface LogQuery { readonly limit?: number; readonly since?: string; readonly level?: "all" | "info" | "warn" | "error"; readonly query?: string; }
export interface LogTail { readonly logs: string; readonly truncated: boolean; readonly nextCursor: string | null; }
```

`ProcessController.readLogTail(query)` 只读取最大 256KB，按行解析时间、level 和 text；`limit` clamp 到 `1..2000`，`since` 按行 cursor 跳过旧内容，`query` 对脱敏前后的安全文本做大小写不敏感匹配。Supervisor 路由把 URL query 转为 `LogQuery`，响应继续经过现有 `sanitizeLogContent`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/log-filter.test.ts tests/integration/supervisor.test.ts`

Expected: all log tests PASS，既有 Supervisor 测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/supervisor/log-filter.ts src/supervisor/process-controller.ts src/supervisor/app.ts src/supervisor/types.ts tests/unit/log-filter.test.ts tests/integration/supervisor.test.ts
git commit -m "feat: add filtered incremental supervisor logs"
```

### Task 4: Web API 类型与独立设置路由壳

**Files:**
- Create: `web/src/app/WorkspaceApp.tsx`
- Create: `web/src/app/page-router.ts`
- Create: `web/src/features/settings/SettingsPage.tsx`
- Create: `web/src/features/settings/SettingsNav.tsx`
- Create: `web/src/features/settings/settings-state.ts`
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api-client.ts`
- Test: `web/src/features/settings/settings.test.tsx`, `web/src/app/layout.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `settings.test.tsx` 断言：

```tsx
it("renders settings navigation at /settings");
it("filters sections by label and keeps the active section");
it("renders unavailable sections without throwing");
```

在 `layout.test.tsx` 断言 `/` 渲染工作台、`/settings` 不创建 SSE/WS 连接，返回聊天后连接恢复。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=web -- src/features/settings/settings.test.tsx src/app/layout.test.tsx`

Expected: FAIL because pathname routing and settings components do not exist。

- [ ] **Step 3: 拆分 App 并加入路由**

将当前 `App.tsx` 的工作台实现移动到 `WorkspaceApp.tsx`，保留现有 reducer、SSE/WS effect 和 handlers。`App.tsx` 只根据 `window.location.pathname` 选择：

```tsx
export function App() {
  const route = usePageRoute();
  return route === "settings" ? <SettingsPage /> : <WorkspaceApp />;
}
```

`page-router.ts` 使用 `popstate` 订阅，不引入路由依赖；设置页链接使用 `history.pushState`，浏览器后退回到聊天。

在 `web/src/lib/types.ts` 增加 `PreferencesDocument`, `LogQuery`, `LogTail`，在 `ApiClient` 增加 `getPreferences`, `updatePreferences`, `getSupervisorLogs(query)`。

- [ ] **Step 4: 运行 Web 测试**

Run: `npm run test --workspace=web -- src/features/settings/settings.test.tsx src/app/layout.test.tsx`

Expected: route and shell tests PASS，既有聊天测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/app/App.tsx web/src/app/WorkspaceApp.tsx web/src/app/page-router.ts web/src/features/settings/SettingsPage.tsx web/src/features/settings/SettingsNav.tsx web/src/features/settings/settings-state.ts web/src/lib/types.ts web/src/lib/api-client.ts web/src/features/settings/settings.test.tsx web/src/app/layout.test.tsx
git commit -m "feat: add independent web settings route"
```

### Task 5: 设置中心 section 与保存状态

**Files:**
- Create: `web/src/features/settings/sections/ProvidersSection.tsx`
- Create: `web/src/features/settings/sections/DefaultsSection.tsx`
- Create: `web/src/features/settings/sections/LayoutSection.tsx`
- Create: `web/src/features/settings/sections/LogsSection.tsx`
- Create: `web/src/features/settings/sections/RuntimeSection.tsx`
- Create: `web/src/features/settings/sections/UnavailableSection.tsx`
- Create: `web/src/features/settings/settings.css`
- Modify: `web/src/features/settings/SettingsPage.tsx`
- Modify: `web/src/features/settings/settings-state.ts`
- Modify: `web/src/features/providers/ProviderSettings.tsx` only to extract reusable form props
- Test: `web/src/features/settings/sections/settings-sections.test.tsx`

- [ ] **Step 1: 写失败测试**

覆盖：Provider 已配置状态不回显 key、默认模型保存/失败提示、日志筛选刷新、Runtime 状态展示和 future section disabled 文案。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=web -- src/features/settings/sections/settings-sections.test.tsx`

Expected: FAIL because section components and API state are absent。

- [ ] **Step 3: 实现设置 shell 和 section**

`SettingsPage` 首次挂载读取 preferences、providers、models 和 supervisor status；各 section 使用独立 `ErrorBoundary` 和 `loading/saving/saved/error` 状态。导航分组固定为 `models`, `defaults`, `layout`, `logs`, `runtime`, `future`，搜索只过滤导航，不卸载当前草稿。

`ProvidersSection` 复用现有 Provider 表单，保存后刷新 Provider/Model；`DefaultsSection` 只提交 `defaults` patch；`LayoutSection` 显示当前 CSS 变量值并提供恢复默认按钮；`LogsSection` 采用 2 秒轮询但仅在当前 section 激活时运行，提交 `limit/level/query/since`；`RuntimeSection` 展示 PID、端口、版本和数据目录；`UnavailableSection` 是禁用的占位，不发送 API 请求。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test --workspace=web -- src/features/settings/sections/settings-sections.test.tsx`

Expected: all section tests PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/features/settings web/src/features/providers/ProviderSettings.tsx web/src/features/settings/sections/settings-sections.test.tsx
git commit -m "feat: build settings center sections"
```

### Task 6: 侧栏尺寸、折叠动效与 Focus 模式

**Files:**
- Create: `web/src/features/layout/use-panel-resize.ts`
- Create: `web/src/features/layout/layout-preferences.ts`
- Modify: `web/src/app/state.ts`
- Modify: `web/src/app/WorkspaceApp.tsx`
- Modify: `web/src/components/ServerStatusBar.tsx`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/InspectorSidebar.tsx`
- Modify: `web/src/app/layout.css`
- Test: `web/src/features/layout/layout.test.tsx`, `web/tests/e2e/workspace.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `layout.test.tsx` 覆盖 `clampWidth`, reduced-motion 和保存 debounce；Playwright 增加：

```ts
test("dragging both panel handles persists widths");
test("both panels collapsed exposes Focus mode and can restore either side");
test("narrow drawer still uses one-open-at-a-time backdrop");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=web -- src/features/layout/layout.test.tsx`

Expected: FAIL because width state and resize handles do not exist。

- [ ] **Step 3: 实现 layout preference 与 pointer resize**

`layout-preferences.ts` 导出 `mergeLayoutPreferences`, `saveLayoutPreferences` 和 `DEFAULT_LAYOUT`. `usePanelResize(side)` 使用 Pointer Events、200/420 与 240/520 clamp、动态聊天最小宽度 420、全屏 shield 和 cleanup；拖拽结束后调用 `ApiClient.updatePreferences`，失败保留内存状态并显示可重试提示。

在 `WorkspaceApp` 挂载时把服务端 layout 偏好写入 CSS variables；CSS 使用 `width`/`opacity` transition 和 `overflow:hidden`，内容节点在 160ms 后隐藏。`@media (prefers-reduced-motion: reduce)` 将 transition/animation-duration 设为 `0ms`。两栏状态同时 collapsed 时给根节点加 `data-focus-mode="true"`，顶部保留展开按钮和 settings link。

- [ ] **Step 4: 运行单元测试和 E2E**

Run: `npm run test --workspace=web -- src/features/layout/layout.test.tsx`

Then: `npm run web:build; cd web; npx playwright test tests/e2e/workspace.spec.ts`

Expected: all layout tests and existing/new workspace scenarios PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/features/layout web/src/app/state.ts web/src/app/WorkspaceApp.tsx web/src/components/ServerStatusBar.tsx web/src/components/SessionSidebar.tsx web/src/components/InspectorSidebar.tsx web/src/app/layout.css web/src/features/layout/layout.test.tsx web/tests/e2e/workspace.spec.ts
git commit -m "feat: add resizable animated workspace panels"
```

### Task 7: 流式事件批处理与时间线稳定性

**Files:**
- Create: `web/src/features/chat/stream-buffer.ts`
- Modify: `web/src/features/chat/chat-state.ts`
- Modify: `web/src/app/WorkspaceApp.tsx`
- Modify: `web/src/features/chat/MessageList.tsx`
- Modify: `web/src/components/ChatPane.tsx`
- Test: `web/src/features/chat/stream-buffer.test.ts`, `web/src/features/chat/chat.test.tsx`

- [ ] **Step 1: 写失败测试**

覆盖：

```ts
it("coalesces multiple deltas into one frame flush");
it("keeps per-stream sequence order and drops duplicate events");
it("updates one tool block in place while preserving timeline order");
it("flushes pending events on turn completion and clears the buffer");
```

为 `chat.test.tsx` 增加正文/思考/工具/计划/附件顺序和缺失 `message.started` 的批量事件测试。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=web -- src/features/chat/stream-buffer.test.ts src/features/chat/chat.test.tsx`

Expected: FAIL because `StreamBuffer` and `EVENT_BATCH` are absent。

- [ ] **Step 3: 实现按帧 buffer 和 reducer 批量 action**

`StreamBuffer` API 固定为：

```ts
class StreamBuffer {
  push(event: PlatformEventEnvelope): void;
  flushNow(): void;
  dispose(): void;
}
```

按 `sessionId + streamId` 分桶；第一次事件安排 `requestAnimationFrame`，无 rAF 时使用 33ms timeout；同一帧事件保持到达顺序。`WorkspaceApp` 将 SSE/WS 回调改为 `buffer.push`，组件卸载调用 `dispose`。

`chatReducer` 增加 `EVENT_BATCH`，逐个复用现有 `EVENT` 语义，先按 stream cursor 去重；为 timeline item 保存 `streamId` 和首个 sequence，工具 block id 固定使用 `toolCallId`，thinking block id 固定使用 `thinking-${streamId}`。`turn.completed` 后 flush、清理 pending stream 状态，不清理已完成 timeline。

- [ ] **Step 4: 优化 MessageList 和 Markdown 更新**

保留当前历史去重策略；将 timeline item 渲染器拆成 `MessageBlock`, `ThinkingBlock`, `ToolBlock`, `PlanBlock`, `AttachmentBlock` 五个 memoized 组件。流式 assistant message 只在 batch flush 时更新；完成时调用完整 `renderSafeMarkdown`。不改变工具卡片的 `data-testid`。

- [ ] **Step 5: 运行 Web 测试**

Run: `npm run test --workspace=web -- src/features/chat/stream-buffer.test.ts src/features/chat/chat.test.tsx`

Expected: all stream and timeline tests PASS。

- [ ] **Step 6: 提交**

```bash
git add web/src/features/chat/stream-buffer.ts web/src/features/chat/chat-state.ts web/src/app/WorkspaceApp.tsx web/src/features/chat/MessageList.tsx web/src/components/ChatPane.tsx web/src/features/chat/stream-buffer.test.ts web/src/features/chat/chat.test.tsx
git commit -m "perf: batch streaming events and stabilize chat timeline"
```

### Task 8: 自动滚动、恢复提示与状态诊断 UX

**Files:**
- Create: `web/src/features/chat/use-chat-scroll.ts`
- Modify: `web/src/features/chat/MessageList.tsx`
- Modify: `web/src/components/ChatPane.tsx`
- Modify: `web/src/app/WorkspaceApp.tsx`
- Modify: `web/src/app/layout.css`
- Test: `web/src/features/chat/chat-scroll.test.tsx`, `web/tests/e2e/workspace.spec.ts`

- [ ] **Step 1: 写失败测试**

覆盖底部跟随、用户上滑暂停、点击“跳到最新”、恢复期间显示 degraded/recovering 且不清空已有消息。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=web -- src/features/chat/chat-scroll.test.tsx`

Expected: FAIL because scroll hook and latest-message action do not exist。

- [ ] **Step 3: 实现滚动 hook 与可恢复状态**

`useChatScroll` 维护 `isAtBottom`, `hasUnread`, `scrollToLatest`; 距离底部小于 48px 才自动滚动，用户主动滚动超过阈值后只累积 unread。MessageList 使用固定 `ref`，不因 timeline 更新而替换 DOM。

SSE/WS error 只更新 `recovering` 状态；连续重连成功后清除提示。不可恢复的 API 错误仍显示 error banner，但不覆盖用户已发送消息。

- [ ] **Step 4: 运行测试和桌面/窄屏 E2E**

Run: `npm run test --workspace=web -- src/features/chat/chat-scroll.test.tsx`

Then: `npm run web:build; cd web; npx playwright test tests/e2e/workspace.spec.ts`

Expected: auto-scroll, second-turn recovery and existing E2E all PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/features/chat/use-chat-scroll.ts web/src/features/chat/MessageList.tsx web/src/components/ChatPane.tsx web/src/app/WorkspaceApp.tsx web/src/app/layout.css web/src/features/chat/chat-scroll.test.tsx web/tests/e2e/workspace.spec.ts
git commit -m "feat: improve streaming scroll and recovery feedback"
```

### Task 9: 全量验收、性能检查和文档

**Files:**
- Modify: `README.md`
- Create: `plans/phase-04.md`
- Modify: `web/tests/e2e/workspace.spec.ts`

- [ ] **Step 1: 补齐 Playwright 主流程**

在现有 fixture 中加入完整验收：打开 `/settings`、修改全局默认、创建新 Session、验证旧 Session 覆盖、拖拽左右栏、刷新恢复、Focus 模式、日志过滤、真实 Provider 流式正文/思考/工具顺序、断线 Resume 和“跳到最新”。

- [ ] **Step 2: 运行全套质量门**

```powershell
npm run check
cd web
npx playwright test
```

Expected: PI import 检查、服务端测试、Web 测试、类型检查、生产构建和所有 Playwright 场景全部通过。

- [ ] **Step 3: 做 viewport 和可访问性检查**

使用 Playwright 检查 `1440x900`、`1024x768`、`768x900`、`390x844`：无横向溢出、无遮罩穿透、Focus 模式可恢复、所有图标按钮有 accessible name、键盘可打开/关闭设置和抽屉。对 `prefers-reduced-motion: reduce` 截图确认无动画闪烁。

- [ ] **Step 4: 更新用户文档**

在 `README.md` 增加 `/settings` 使用入口、全局默认与 Session 覆盖规则、偏好文件位置、日志筛选方式和 Focus/侧栏调宽说明；在 `plans/phase-04.md` 记录每个任务的提交号和验收结果。

- [ ] **Step 5: 提交验收结果**

```bash
git add README.md plans/phase-04.md web/tests/e2e/workspace.spec.ts tests/e2e/phase4-settings.test.ts
git commit -m "test: complete phase 4 web acceptance"
```

## 最终检查清单

- [ ] `preferences.json` 缺失、损坏、旧版本都能恢复，不阻塞 Supervisor。
- [ ] 全局默认模型只影响新建 Session，Session 覆盖隔离。
- [ ] 设置页 section 搜索、保存、错误恢复和 future placeholder 完整可用。
- [ ] 左右栏调宽、持久化、折叠动效、Focus 模式和窄屏抽屉无回归。
- [ ] 流式正文、思考、工具、计划、附件按事件顺序显示，批处理不丢/不重事件。
- [ ] 用户上滑时不被强制滚到底部，恢复提示和跳到最新可用。
- [ ] 日志查询有 limit/since/level/query、cursor、脱敏和状态元数据。
- [ ] `npm run check`、Playwright、生产构建、桌面/窄屏/手机 viewport 和键盘检查通过。

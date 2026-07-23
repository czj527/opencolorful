# Phase 4 交互体验与基础设施优化设计

**状态：设计草案，待用户审阅**  
**基线：Phase 3 已合并到 `main`**  
**参考：`<local-workspace>\openhanako` 的 Web 设置、侧栏 resize 和流式 buffer 实现**

## 1. 目标与边界

Phase 4 采用“增强三栏工作台 + 独立设置中心”的增量方案，继续复用 Phase 3 的 Supervisor、Agent Server、REST、SSE、WS、Provider、Session 和 PI 工具基础设施。

### 目标

- 保留当前三栏工作台作为默认入口；左右栏完全收起后进入聊天优先 Focus 模式。
- 提供独立 `/settings` 页面，承载全局模型默认值、Provider 管理、界面布局、日志与运行时诊断，并为未来 Profile、记忆、多 Agent、插件设置保留导航扩展点。
- 区分全局默认配置与 Session 覆盖配置：全局配置只作为新建会话默认值，Session 覆盖不反向修改全局配置。
- 让真实 LLM 流式输出按执行时间线稳定渲染，正文、思考、工具卡片、计划和附件不丢失、不重复、不乱序。
- 改善侧栏调宽、收起、展开和窄屏抽屉的过渡体验，同时保持布局状态可持久化和可恢复。
- 提供可筛选、脱敏、可增量读取的日志与诊断体验，降低 Supervisor 短暂不可达造成的误报。

### 不在本阶段

- 不实现 OAuth、沙盒、逐次工具审批、记忆、多 Agent、插件业务本身。
- 不重写 PI SDK、Session JSONL、SSE/WS 协议核心语义。
- 不拆出第二个 Web Bundle 或 Electron 窗口；设置中心是同源 Web 路由。
- 不把所有 UI 状态一次性迁移到新的全局状态库；只建立清晰的布局、路由和聊天流边界。

## 2. 设计原则

1. **增量复用**：ProviderStore、AuthStorage、SessionService、Supervisor 日志接口、事件 cursor 和现有工具策略继续作为唯一事实源。
2. **配置分层**：全局默认设置与 Session 覆盖设置分别持久化、分别验证、分别展示。
3. **时间线优先**：流式事件先建立稳定的 turn/block 标识，再投影为 UI；工具卡片属于 assistant turn 的事件序列，而不是独立的旁栏。
4. **稳定尺寸**：侧栏宽度、折叠状态和 Focus 模式采用稳定的布局轨道，动画不改变聊天内容的可用宽度计算方式。
5. **可恢复优先**：任何网络抖动、SSE 重连、WS Resume、设置加载失败都显示可恢复状态，并保留用户当前草稿和已接收事件。
6. **可扩展但不预实现**：设置导航用 capability/section id 扩展，未来功能可插入而不改变聊天页的信息架构。

## 3. 用户体验设计

### 3.1 工作台模式

默认仍为三栏：

- 左侧：Session 列表、搜索、新建、归档。
- 中间：聊天标题、模型选择、消息时间线、Composer。
- 右侧：当前 Session 设置、Provider 快捷配置、诊断入口。

左、右栏均支持：

- 点击按钮折叠/展开。
- 拖拽边界调整宽度。
- 宽度在最小值和最大值之间 clamp，并持久化。
- 折叠时内容先淡出、再隐藏溢出；展开时先恢复轨道、再淡入内容。

当两侧都折叠时，中间聊天区进入 Focus 模式：

- 中间区域占满可用宽度。
- 顶部保留两侧展开按钮、连接状态、当前会话标题和设置入口。
- 不创建第二套聊天状态，恢复任一侧后回到原三栏布局。

窄屏保持当前“抽屉 + 遮罩 + 一次只打开一侧”的行为，增加宽度上限、过渡动画和 Escape/遮罩关闭；桌面端不使用遮罩。

### 3.2 独立设置中心

通过顶部设置按钮进入 `/settings`。页面采用 OpenHanako 风格的设置信息架构：

- 左侧设置导航，可搜索、分组、显示当前项。
- 右侧内容区显示页面标题、说明、分组设置和保存状态。
- 刷新 `/settings` 后保持当前设置 section；从设置返回聊天时保留 Session、草稿和侧栏布局。
- 设置加载失败时显示 section 级错误，不阻塞其他 section；保存操作显示 saving/saved/error 状态。

首批 section：

1. **模型与 Provider**：Provider 列表、模型能力、凭据是否已配置、默认 Provider/模型。
2. **默认对话**：默认思考级别、工具权限、工作目录策略；说明 Session 覆盖优先级。
3. **界面与布局**：左右栏宽度、Focus 模式、动效开关、减少动效跟随系统设置。
4. **日志与诊断**：Supervisor/Agent 日志、级别/关键词筛选、刷新、复制、当前进程状态。
5. **运行时与关于**：Supervisor/Agent 版本、端口、PID、数据目录、配置文件位置。
6. **预留 section**：Profile、记忆、多 Agent、插件，显示“尚未启用”而不实现业务。

凭据只允许写入，不在 UI 回显；已配置状态使用布尔标记和脱敏文案。

### 3.3 流式消息体验

每一轮 assistant turn 使用统一时间线渲染：

```text
用户消息
思考块（可折叠）
assistant 正文片段
工具卡片（started/delta/completed）
assistant 后续正文片段
计划/附件投影
最终 assistant 正文
```

具体规则：

- 用户消息在 Prompt 请求返回前立即显示；请求失败时标记为发送失败并允许重试。
- 正文和思考独立累积，不因为缺少 `message.started` 而丢弃后续 delta。
- 工具卡片按 `toolCallId` 原地更新，工具完成后保留结果和错误状态。
- Markdown 在流式期间采用节流渲染，完成后再做完整安全 Markdown 渲染。
- 用户位于消息底部时自动跟随；用户上滑阅读历史时不强制跳转，显示“跳到最新”。
- `prefers-reduced-motion` 下不显示光标闪烁和位移动效，但保留状态颜色和文本。

## 4. 架构与数据流

### 4.1 全局偏好

新增 `preferences.json` 的版本化文档，使用现有 `RuntimePaths.preferences`：

```ts
interface PreferencesDocument {
  version: 1;
  defaults: {
    model: { providerId: string; modelId: string } | null;
    thinkingLevel: ThinkingLevel;
    toolMode: ToolMode;
  };
  layout: {
    leftSidebarWidth: number;
    rightSidebarWidth: number;
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    focusMode: boolean;
    reducedMotion: "system" | "on" | "off";
  };
}
```

要求：

- 使用版本化归一化后再做 TypeBox schema 校验；读取时忽略未知字段，写回时只保留合法字段。
- 使用临时文件 + rename 原子写入，损坏文件回退默认值并保留诊断日志。
- 默认模型必须通过 ModelService.resolveModel 验证；模型删除或 Provider 无凭据时返回可见 warning，不阻塞 Web 启动。
- Session 创建时读取默认值；已有 Session 的显式值不被全局更新覆盖。

新增 API：

- `GET /api/settings/preferences`
- `PUT /api/settings/preferences`

请求/响应不包含 API key；Provider 写入继续复用现有 `PUT /api/settings/providers`。

### 4.2 设置与日志 API

扩展 `GET /api/supervisor/logs`：

- `limit`：返回最后 N 行，服务端设硬上限。
- `since`：按日志时间或服务端 cursor 返回增量内容。
- `level`：`all | info | warn | error`，过滤在服务端执行或对结构化日志执行。
- 保持现有脱敏逻辑；返回 `truncated`、`nextCursor` 和当前状态元数据。

如果日志文件仍为纯文本，先在读取层做轻量行解析；不在 Phase 4 强制迁移日志格式。后续可在 `LogService` 中替换为结构化存储而不改变前端接口。

### 4.3 布局状态

新增 `usePanelResize` 和 `layout-preferences` 边界：

- 使用 Pointer Events，支持鼠标和触控板；拖拽期间添加全屏透明 shield，避免选中文本和跨 iframe 事件。
- 左栏默认范围 200-420px，右栏默认范围 240-520px；聊天区保留最小 420px，按视口动态收紧最大值。
- CSS 变量负责实时尺寸；拖拽结束后通过 preferences API 防抖保存。
- 折叠/展开只改变布局状态，不卸载聊天流和 SSE/WS 客户端。
- 动画 duration/easing 使用 CSS 变量；系统减少动效时统一关闭 transition/animation。

### 4.4 流式事件管线

保持 SSE/WS 传输和 sequence cursor，新增客户端 `stream-buffer`：

1. `SseClient`/`WsClient` 收到事件后写入按 session/stream 分桶的队列。
2. 在下一个 `requestAnimationFrame` 或 33ms 超时点批量 flush。
3. `chatReducer` 一次处理事件批次，按 stream cursor 去重和丢弃乱序事件。
4. `turnId/blockId` 由事件中的稳定 ID 优先；缺失时由 `(streamId, event type, toolCallId)` 派生并缓存。
5. UI 投影读取 timeline block，单个 block 更新不重建其他消息。
6. `turn.completed` 清理临时 buffer，历史刷新只合并已落盘消息，不覆盖仍在流中的快照。

批处理只改变渲染频率，不改变事件顺序、持久化或 Resume 语义。

## 5. 模块边界与候选文件

### Server

- Create: `src/contracts/preferences.ts`
- Create: `src/config/preferences-store.ts`
- Modify: `src/server/routes/settings.ts`（或新增统一设置路由）
- Modify: `src/server/routes/sessions.ts`（新建 Session 应用全局默认值）
- Modify: `src/supervisor/app.ts`、`src/supervisor/process-controller.ts`（日志查询参数和诊断元数据）
- Modify: `src/server/app.ts`、`src/server/start.ts`（注入 PreferencesStore）
- Test: `tests/integration/preferences.test.ts`、`tests/integration/settings-routes.test.ts`

### Web

- Create: `web/src/features/settings/SettingsPage.tsx`
- Create: `web/src/features/settings/SettingsNav.tsx`
- Create: `web/src/features/settings/settings-state.ts`
- Create: `web/src/features/settings/sections/ProvidersSection.tsx`
- Create: `web/src/features/settings/sections/DefaultsSection.tsx`
- Create: `web/src/features/settings/sections/LayoutSection.tsx`
- Create: `web/src/features/settings/sections/LogsSection.tsx`
- Create: `web/src/features/settings/sections/RuntimeSection.tsx`
- Create: `web/src/features/settings/sections/UnavailableSection.tsx`
- Create: `web/src/features/settings/settings.css`
- Create: `web/src/features/layout/use-panel-resize.ts`
- Create: `web/src/features/layout/layout-preferences.ts`
- Create: `web/src/features/chat/stream-buffer.ts`
- Modify: `web/src/app/App.tsx`（页面路由和职责拆分）
- Modify: `web/src/app/state.ts`、`web/src/app/layout.css`
- Modify: `web/src/lib/api-client.ts`、`web/src/lib/types.ts`
- Modify: `web/src/features/chat/chat-state.ts`、`MessageList.tsx`、`ChatPane.tsx`
- Test: Web unit/component tests and `web/tests/e2e/workspace.spec.ts`

### 参考 OpenHanako 的边界

- `desktop/src/react/settings/SettingsContent.tsx`：设置页面 shell、section 级 ErrorBoundary 和加载超时。
- `desktop/src/react/settings/SettingsNav.tsx`：可搜索导航、活动项和未来插件 section 插入点。
- `desktop/src/react/hooks/use-sidebar-resize.ts`：clamp、CSS 变量、localStorage 持久化、拖拽 shield 和清理。
- `desktop/src/react/hooks/use-stream-buffer.ts`：文本节流、工具组原地更新、turn 结束清理和流中快照。

只借鉴边界和交互原则，不复制 OpenHanako 的 Electron bridge、主题资源或业务模型。

## 6. 错误处理与兼容性

- 偏好文件缺失：创建默认文档；损坏：回退默认值并在日志显示 repair warning。
- 默认模型不可用：设置页标红 Provider/模型，聊天页保留“未选择模型”状态；不阻塞 Supervisor。
- 设置保存冲突：返回 `409` 并保留草稿，提示重新加载最新值。
- 日志读取失败：显示最后一次成功快照和重试按钮；不把 Web 连接状态改为 error。
- SSE/WS 短暂断线：显示 recovering/degraded，继续使用 cursor resume；连续不可恢复才显示 error。
- 浏览器不支持 Pointer Events 或减少动效：退化到点击折叠和无动画布局。
- 旧 preferences 版本：提供显式迁移函数，不静默删除用户布局。

## 7. 测试与验收策略

### 契约与服务端

- Preferences schema：默认值、未知字段、损坏 JSON、版本迁移、原子写入。
- Settings routes：GET/PUT、模型可用性校验、Session 创建应用默认值、Session 覆盖隔离。
- Logs：limit/since/level、cursor、截断和密钥脱敏。
- Supervisor：degraded/error/stopped 状态映射不回归。

### Web 单元与组件

- SettingsNav 搜索、分组、section 切换、未知 section 占位。
- Layout reducer/resize：clamp、动态聊天最小宽度、持久化、防抖和 reduced-motion。
- Stream buffer：多 token 合并、工具卡片原地更新、乱序/重复事件、turn 完成清理。
- MessageList：正文/思考/工具/计划/附件顺序、历史去重、Focus 模式。
- 自动滚动：底部跟随、上滑停留、跳到最新。

### Playwright 验收

1. 从聊天进入 `/settings`，切换 Provider、默认模型、布局 section，再返回聊天。
2. 修改全局默认后新建 Session；确认已有 Session 覆盖值不变。
3. 拖拽左右栏宽度、刷新页面、重启 Web，确认宽度和折叠状态恢复。
4. 两栏完全收起进入 Focus 模式，展开任一侧恢复三栏且聊天流不中断。
5. 真实 Provider 长回复包含思考、工具和最终正文，检查事件顺序和渲染节流。
6. 上滑历史后继续接收流，确认不强制滚底；点击“跳到最新”恢复。
7. 断开 SSE/WS、恢复连接、发送第二轮 Prompt，确认无重复和丢失。
8. 日志筛选、增量刷新、脱敏和错误重试。
9. 桌面、1024px、768px 和手机宽度检查无重叠、无横向溢出。

质量门：`npm run check`、`cd web && npx playwright test`、生产 Web 构建、PI import 检查全部通过。

## 8. 交付拆分

- **Phase 4.0：契约与偏好存储**。先完成 schema/store/API 和服务端测试。
- **Phase 4.1：独立设置中心**。完成 `/settings` shell、导航、Provider/默认值/日志/运行时 section。
- **Phase 4.2：布局交互**。完成可调宽侧栏、折叠动效、Focus 模式、窄屏抽屉回归。
- **Phase 4.3：流式渲染**。完成 stream-buffer、批量 reducer、block timeline、自动滚动。
- **Phase 4.4：诊断与验收**。完成日志增量、错误恢复、全量测试、性能和无障碍检查。

每个子阶段都必须有独立测试、独立提交和可运行的 Web 体验，不允许把设置、布局和流式重构合并成一个无法回滚的大提交。

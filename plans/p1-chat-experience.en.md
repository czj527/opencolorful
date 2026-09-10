# P1 Chat Experience Fixes（对话体验阻塞修复）

状态：in-review
 owner：主 Agent（k3）
 日期：2026-09-10

## 动机

用户实测 v0.1.2/v0.1.3 后报告核心对话流程阻塞项：

1. 每个新会话时间线弹出「条目 session_info / model_change ×3 / thinking_level_change」簿记噪音行；
2. 会话时间线横排在对话顶部，不符合「左侧竖排轮次摘要、快速定位」的预期形态（参考 lobe-chat 话题列表 / kimi web）；
3. 修改 Provider 配置后已打开会话仍用旧配置，必须新建会话才生效；
4. GitHub Release v0.1.3 notes 双重编码乱码（人工粘贴引入）。

## 改动清单

### Desktop（对话页）

- `desktop/src/data/projector.ts`：`projectBranchEntries` 不再投影非 message、非 compaction 的簿记条目（session_info / model_change / thinking_level_change / label）；簿记状态的可见性由 Composer chip 与会话头部承担。
- `desktop/src/components/TimelineNav.tsx` + `.css`：时间线从顶部横排改为对话区左侧竖排（圆点+竖线串联轮次，摘要取自用户提问截断 36 字 + 相对时间，点击滚动定位高亮；<940px 窄窗口自动隐藏）。不展示工具调用等过程条目。
- `desktop/src/components/ChatView.tsx`：返回结构改为 `.chat-layout > (.timeline-nav + .chat-main)`；EventRow 行为——单个工具调用的 live 行默认展开（openhanako 取舍：单步铺开、多步折叠计数）；thinking 行进行中强制展开、完成后收起（lobe-chat 取舍）。
- `desktop/src/components/Composer.tsx`：工具模式/思考强度 chip 显示中文档位（免工具/只读/全部工具；关/极简/低/中/高/很高/最高），菜单项内保留英文协议值。
- `desktop/src/components/NewSessionDialog.tsx`：思考级别选项显示 `中（medium）` 格式。
- `desktop/src/App.tsx`：新会话自动标题截断 18 → 30 字符。
- `desktop/src/styles.css`：`.chat-layout` / `.chat-main` 布局规则。

### 后端（配置实时生效）

- `src/runtime/model-service.ts`：新增 `configVersion`（单调递增代次，upsert 重建 PI ModelRuntime 成功后 +1）。
- `src/server/routes/runtime-bootstrap.ts`：Provider 配置代次纳入 runtime 重建白名单（原白名单：Agent systemPrompt、插件签名）。Runtime 已存在时比对代次，不一致则 invalidate + 重建——修改 Provider 端点/凭据/模型清单后，已打开会话下一回合自动使用新配置。重建检查从无 agent 会话豁免改为全量会话（`pluginSignature(undefined)` 零成本短路，无性能回归）；跟踪条目缺失（测试/TUI 直挂 `promptService.register`，非本 bootstrap 创建）时跳过漂移检测，避免「无条目 ≠ 空签名」误判导致的反复重建（tui-smoke 回归实锤后修复）。

### 发布流程

- `docs/release.md`：release notes 禁止手动粘贴/PowerShell 管道传中文（v0.1.3 双重编码乱码教训），改为 UTF-8 无 BOM 临时文件 + `gh release edit --notes-file` + `gh release view` 回读复核。
- v0.1.3 Release body 已按此流程重传修复（仓库外操作，2026-09-10）。

## 验证证据

- `npx vitest run --maxWorkers=2`（desktop）：25 文件 / 123 测试全绿（断言适配见下）。注：本机默认全并发跑 desktop vitest 存在环境性 setup 超时抖动（改动前已存在，还原对照实验证明），CI 无此问题。
- `npx vitest run tests/unit/model-service-version.test.ts tests/integration/provider-settings.test.ts`：9/9 通过（新增代次测试 1 个）。
- `npx vitest run tests/integration/prompt-events.test.ts tests/integration/session-lifecycle.test.ts`：10/10 通过（ensureRuntime 路径回归）。
- `npx tsc --noEmit`（根）+ desktop 双 tsconfig：通过。
- 真链验收巡演（`--grep @acceptance`，lane-a4b）：6/6 通过，截图终审确认：无簿记噪音行、左侧竖排时间线、中文 chip（`desktop/test-artifacts/acceptance-tour/A-1、A-4`）。
- 测试断言适配（4 个 mock 测试文件 + branch-data 单测）：仅文案/结构断言更新，测试意图不变（回滚收敛语义、展开收起双向覆盖保留）。

## 已知偏差

- **lane-b45 四挂为 main 既有回归，与本 PR 无关**：B-1/B-4/B-5/B-6 在纯 origin/main（ae7186f，git stash 对照实验证明）上同样失败——后端 turn 完整落盘但前端不渲染助手回复。根因调查中（最大嫌疑 eaa8656 Wave C 入口门禁），将单独立项修复，不阻塞本 PR。
- A-3 错误行持久化（发现 #2）与 api-proxy 错报（发现 #1）仍为既有立项项，不在本 PR 范围。
- 侧栏会话行首轮后仍显示「（空会话）」（live 预览不刷新）为已知低危打磨项。

## 后续收口（2026-09-11）：A-3 错误行持久化已实现

「运行错误」状态卡此前只存在于渲染进程内存，任何 seedItems 整表重投影（历史装载/分支切换/SSE 重连追平）都会冲掉它，重启后历史里也无失败痕迹。修复沿投影链透出 PI 已持久化的失败（assistant message 条目 `stopReason="error"` + `errorMessage`，不写新数据、不改 SQLite schema）：

- `src/pi-sdk/session-tree.ts` / `src/pi-sdk/types.ts`：`PiSessionTreeEntry` / `PiMessageEntry` 新增可选 `errorMessage`（adapter 只搬运原始值，不截断不脱敏）；树/分支条目与 `flattenMessageEntries`（messageEntries 视图）均透出。
- `src/contracts/session-branch.ts` + `src/runtime/session-service.ts`：`SessionEntryView` 透传 `errorMessage`；`buildEntryViews` 与 `toView` 的 messageEntries 装配点统一脱敏截断（`sanitizeSensitiveText(…, 200)`，与 event-mapper live 路径同规）。
- `desktop/src/data/projector.ts` + `source.ts` + `ipc-source.ts`：`BranchEntry` / `HistoryEntry` / `BranchEntryView` 透传；`projectBranchEntries` / `projectHistory` 对失败条目——正文非空 → 消息 meta 标「生成失败」（对齐 live turn.failed 文案）；正文为空 → 不渲染空气泡；随后追加「运行错误」状态卡（id `entry-error-<entryId>` / `history-error-<index>`，meta「历史」）。

验证：`npx vitest run tests/contract/session-tree.test.ts`（8/8，新增失败条目用例）、`npx vitest run tests/integration/session-branch-api.test.ts`（9/9，新增条目视图脱敏截断用例）、desktop `npx vitest run tests/unit/branch-data.test.ts`（17/17，新增投影用例）、`npm run check` 全量（见提交证据）。已知偏差中 A-3 项就此关闭；api-proxy 错报仍为独立立项项。

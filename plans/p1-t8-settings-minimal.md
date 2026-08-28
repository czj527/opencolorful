# P1 T8：设置页四类目极简重构（lane log）

**日期：2026-08-28** · **执行：主 agent（UI 美学任务按约定不派发）** · 规格：`docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`（D2/D2a）

## 方案

设置页 10 类目 25 死控件 → 4 类目全接线：

- **外观**：主题三选（既有，已接线）+ 减少动效 toggle（localStorage，`html[data-reduce-motion]` CSS gate，与系统级 media query 等价且独立）。
- **模型与 Provider**：新增**全局默认模型**选择器（`PUT /api/settings/preferences`，后端早已存在；数据源三件套补 `updatePreferences`；保存后 App `prefsRefresh` 重拉偏好，草稿运行设置联动）+ 现有 ProvidersSettings 保留。无可选模型（未配凭据）时降级为提示文本；当前默认不在可用列表时给警示行。
- **对话显示**：显示思考事件 / 显示工具调用两个 toggle（localStorage，默认全开；`ChatView` 用 `useMemo` 过滤时间线渲染，只影响本地显示，不动事件流与回放数据）。
- **关于**：桌面端版本 / 数据源 + 连接状态，只读文本行，去掉可点击样式。
- **删除**：通用/Agent/会话与工作区/记忆/Subagent/日志与诊断/插件与 Skills/权限与安全 8 个类目（Agent 与记忆编辑在档案页已有、会话级设置在会话内已有，无后端支撑的不留尸体；Subagent 默认模型/诊断偏好/插件启停记规格 backlog）。

## 新文件

- `desktop/src/data/local-prefs.ts`：本地界面偏好 store（`useSyncExternalStore` 订阅，单 JSON key `ocf-desktop-local-prefs`，解析失败回退默认；存储不可用时仅本次会话生效）。

## 设计修正记录（实施中发现）

1. **ThreadRow 嵌套 button（顺带修复）**：T3 行内改标题把编辑按钮放进了行按钮里，HTML 非法嵌套，React 每次渲染报 hydration 警告。外层改 `div[role=button][tabIndex]` + Enter/Space 键支持，视觉零变化（`.thread-row` 纯类名驱动），编辑按钮冒泡本就被 `startEdit` 阻断。
2. **默认模型选项编码**：`<option value>` 用 `JSON.stringify({providerId, modelId})`，避免分隔符转义问题。
3. **App 草稿模型不强制跟随新默认**：默认模型保存后，已存在的草稿选择若仍在可用列表则保留（既有"用户选择优先"语义）；新默认对后续新建会话生效。符合直觉，不改。

## 验证证据（主 agent 本 lane 独立执行）

- `npx tsc --noEmit`（desktop）✓；`npx tsc --noEmit -p tsconfig.json`（根）✓
- `npx vitest run tests/unit/desktop-projector.test.ts` 11/11 ✓
- `npm run build`（desktop vite build）✓
- 视觉冒烟（Playwright + vite mock 模式，`desktop/smoke-t8.mjs`，截图在 `desktop/shots/`（lane 内，未提交））：四类目渲染正确；默认模型选择器回显 mock 偏好（Kimi K3/moonshot）；对话显示两 toggle 关闭后时间线 thinking/tool 事件归零、重开即时恢复（DOM 计数断言 0/0 → 1/1）；修复后 console 零报错
- 全量单测后台运行中（结果见 PR 前补充）

## 已知偏差

- mock 的 `updatePreferences` 为内存态合并（对齐服务端 merge 语义），刷新页面回初始 fixture——mock 定位如此，接受。
- "关于"页数据目录未展示：renderer 经 `desktopApi` 拿不到后端数据目录路径，无现成 API；不为此新开端点，待有真实需求再说。

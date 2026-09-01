# P1 热修：新建助理无工作目录时发送消息无反应

**状态：已完成（2026-08-28）**
**触发**：作者在 v0.1.1 安装版实测——新建助理（未填可选工作目录）后发送首条消息完全无反应；期望行为是首条消息自动建会话并进入会话页。

## 根因（两条叠加）

1. **死路**：`desktop/src/data/ipc-source.ts` 的 `createThread` 前端强制要求 Agent 已配置 `defaultCwd`（`NewAgentDialog` 里它是可选项），服务端 `POST /api/sessions` 也强制 `cwd` 必填；且全端没有任何 UI 能为已建 Agent 补配工作目录 → 未填目录的助理永远无法进入对话。
2. **静默**：`App.tsx` 只在非空态分支渲染 `chatError`；新会话草稿态（空态）下 `send()` 失败设置了错误但无处渲染 → 用户视角"完全没反应"。

## 修复

- `src/config/agent-store.ts`：新增 `ensureWorkspace(agentId)`——返回并创建 `<agents>/<id>/workspace/`（路径归属 Agent 数据子树，由 Store 管理）。
- `src/server/routes/sessions.ts`：`POST /api/sessions` 的 cwd 改三级解析——请求显式 > Agent `defaultCwd` > per-agent workspace 兜底（自动建目录）；无 `agentId` 时保持必填（无归属会话没有可兜底工作区）。agentId 校验提前于 cwd 解析。
- `desktop/src/data/ipc-source.ts`：`createThread` 移除前端拦截，cwd 为空时省略该字段交由服务端兜底。
- `desktop/src/App.tsx`：空态 composer 区域渲染 `chatError`（`role="alert"`，复用既有样式），修复整类"草稿态错误不可见"。

## 验证

- `tests/integration/session-agent-binding.test.ts` 新增 3 例：无 cwd 兜底 per-agent workspace（201 + 目录已建）、无 cwd 用 Agent defaultCwd、无 cwd 无 agentId 仍 400；文件 11/11 通过。
- `npx tsc --noEmit`（根）与 desktop `tsc --noEmit` 均通过；`npm run check` 全绿（见提交记录）。
- CHANGELOG `Unreleased` 已记录该用户可见修复。

## 已知缺口（后续）

- 档案页仅展示工作目录、不可编辑；补"助理工作目录编辑"入口（档案页或设置）是独立的 UI 补齐任务。
- 老数据里已存在的无 defaultCwd 助理由本兜底自然治愈，无需迁移。

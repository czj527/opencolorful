# P1 Slice 1 — T6: Desktop Error-Recovery Copy Pass

**Lane:** F  
**Task:** T6 — Audit and repair failure-path copy + next-action affordances across the desktop chat/settings/logs surfaces.  
**Spec reference:** `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md` §二.5  
**Branch:** `feat/p1-t6-error-copy`  
**Base:** `main` with T0 landed.

## 1. Brief

Every user-perceivable failure state on the chat, settings, and logs paths must present a readable Chinese message and a concrete next action. Raw English provider/network errors and silent failures are not acceptable.

This task is limited to copy, error mapping, and lightweight presentation changes. Interaction logic and state machines are not changed.

### Owned files (modified / created)

- `desktop/src/errors.ts` **(new)** — centralized `Error` → Chinese user-facing advice mapper.
- `desktop/src/App.tsx` — chat-level error handling for send, `/compact`, thread rename/unarchive, model/run-setting changes, workspace confirmation.
- `desktop/src/components/Composer.tsx` — no-model tooltip on the disabled model chip.
- `desktop/src/components/ProvidersSettings.tsx` — provider list / save error copy.
- `desktop/src/pages/LogsPage.tsx` — logs and activity query error copy + retry affordance.
- `plans/p1-t6-error-copy.md` **(new)** — this document.

### Files reviewed but intentionally unchanged

- `desktop/src/components/SettingsModal.tsx` — no independent failure state; it only hosts `ProvidersSettings`.
- `desktop/src/components/WorkspaceBanner.tsx` — already presents a clear non-error call-to-action; no failure path here.

### Forbidden (not touched)

- `Sidebar.tsx`, `MemoryPage.tsx`, `AgentProfilePage*`, `OnboardingPage*` (onboarding copy is T1).
- `data/*`, server `src/`, `styles.css`.
- No new dependencies; no git commits/pushes.

## 2. Implementation Record

### 2.1 Centralized mapper: `desktop/src/errors.ts`

A single pure module classifies raw error messages into user-facing scenarios:

| Scenario | Detected by | User message | Next action |
|---|---|---|---|
| Offline / disconnected | `请求失败（0）`, `502`, `fetch failed`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `Connection refused`, `NetworkError`, `offline` | 连接已断开，请检查本地服务是否运行，恢复后会自动重连。 | — |
| Auth / credential failure | `401`, `403`, `Unauthorized`, `Forbidden`, `Invalid API key`, `api key`, `认证`, `凭据`, `credential`, `未配置凭据` | API Key 可能已失效或权限不足，无法完成请求。 | Open Settings → **Models** |
| Session busy (409 / BUSY) | `409`, `BUSY`, `忙`, `无法压缩`, `正在处理` | 会话正在处理其他请求，请稍后再试。 | — |
| No usable model | `没有可用模型`, `未配置模型`, `no model`, `no provider`, `未配置 provider`, `未配置凭据` | 还没有可用模型，请先在设置中配置 Provider 与 API Key。 | Open Settings → **Models** |

If none of the classifiers match, a context-specific fallback is used so callers never fall back to the raw English message.

### 2.2 Before / after copy table

| File | Path | Before | After |
|---|---|---|---|
| `App.tsx` | send → offline | (silent attempt; backend error surfaced raw) | 连接已断开，请检查本地服务是否运行，恢复后会自动重连。 |
| `App.tsx` | send → no usable model | (silent attempt; raw error or nothing) | 还没有可用模型，请先在设置中配置 Provider 与 API Key。 [→ 模型与 Provider] |
| `App.tsx` | send → provider/network error | Raw `cause.message` (e.g. `fetch failed`, `401`) | Mapped to one of the scenarios above + next action. |
| `App.tsx` | `/compact` → busy | 会话忙，压缩稍后再试 | 会话正在处理其他请求，请稍后再试。 |
| `App.tsx` | `/compact` → other error | Raw message / "压缩失败" | 会话压缩失败，请重试。 (or mapped scenario) |
| `App.tsx` | rename thread | Raw message / "重命名失败" | 重命名失败，请重试。 |
| `App.tsx` | unarchive thread | Raw message / "恢复失败" | 恢复会话失败，请重试。 |
| `App.tsx` | change model | "模型切换失败" | 模型切换失败，请重试。 |
| `App.tsx` | change thinking level | "思考级别更新失败" | 思考级别更新失败，请重试。 |
| `App.tsx` | change tool mode | "工具模式更新失败" | 工具模式更新失败，请重试。 |
| `App.tsx` | confirm workspace | "工作区确认失败，请重试" | 工作区确认失败，请重试。 |
| `App.tsx` | switch to read-only | "切换只读失败，请重试" | 切换只读模式失败，请重试。 |
| `Composer.tsx` | model chip disabled | "未配置模型" (no reason) | Tooltip: 还没有可用模型，请先在设置 → 模型与 Provider 中配置凭据 |
| `ProvidersSettings.tsx` | list providers error | Raw message / "Provider 列表加载失败" | Mapped Chinese copy + existing **重试** button. |
| `ProvidersSettings.tsx` | save provider error | Raw message / "保存 Provider 失败" | Provider 保存失败，请检查表单内容后重试。 (or mapped scenario) |
| `LogsPage.tsx` | load logs error | Raw message / "日志加载失败" | Mapped copy + **重试** button. |
| `LogsPage.tsx` | query activity error | Raw message / "活动加载失败" | Mapped copy + **重试** button. |
| `LogsPage.tsx` | load more activity error | Raw message / "加载更多失败" | Mapped copy + **重试** button. |

### 2.3 Code-structure changes

- `App.tsx` `chatError` state widened from `string | null` to `React.ReactNode | null` so the error bar can render an inline action button ("去设置 → 模型与 Provider") without adding new state.
- `App.tsx` `send()` now guards offline and no-model states before calling the backend, so the failure is explicit and recoverable.
- `LogsPage.tsx` `ActivityView` gained a local `retryCount` state; the retry button re-runs the current filtered query without leaking state into the parent.

## 3. Verification

### 3.1 Commands run

From the worktree root `D:\PI-study\.oc-lanes\t6`:

```powershell
npm install --no-audit --no-fund --legacy-peer-deps
npm run desktop:build
```

### 3.2 Results

- `npm install` completed without new dependencies.
- `npm run desktop:build` passed (TypeScript + Vite build for the desktop renderer).

> Note: Full `npm run check` and Playwright E2E are outside the lane scope; the main agent must run them independently during integration review per `AGENTS.md`.

## 4. Risks & Uncovered Paths

The following failure paths are **not** covered by this task because they are owned by other lanes or are outside the current slice:

| Path | Why not covered | Owner / follow-up |
|---|---|---|
| Onboarding wizard error states | Onboarding copy and flow are T1's scope; T1 should reuse `errors.ts` for provider-setup failures. | T1 (lane A) |
| Memory page errors (`MemoryPage.tsx`) | Explicitly forbidden in T6 brief; T5 owns memory daily-use surfaces. | T5 (lane E) |
| Subagent dock errors (`SubagentDock.tsx`) | Not in T6 owned-file list. | Future D-wave / P1 slice 2 |
| First-run probe failure | `use-first-run.ts` intentionally fails open to `ready`; this is product behavior, not an error state. | T0 (main agent) |
| Backend-generated non-English / non-HTTP errors | `errors.ts` maps known patterns. Unknown patterns fall back to context-specific Chinese copy but cannot guess a precise provider diagnosis. | Future: add provider-specific codes as they surface in daily use |
| Settings categories other than "models" | Only the models category has live backend writes in this slice; other settings rows are still placeholder toggles. | Future P1 waves |

## 5. Manual Acceptance Suggestions for the Main Agent

1. **Fresh `OPENCOLORFUL_HOME` with no provider configured**
   - Empty-state chat should show: "还没有可用模型，去配置 Provider 与 API Key →" (existing T0 entry) and the inline action should open Settings → Models.
   - Type a message and press Enter; expect the same no-model message with the settings action button.

2. **Stop the backend / block the port**
   - Send a message; expect "连接已断开，请检查本地服务是否运行…" with no raw network text.
   - Titlebar offline indicator should already be present (not modified by T6).

3. **Configure a provider with an invalid API key**
   - Send a message; expect "API Key 可能已失效或权限不足…" with an action button to Settings → Models.

4. **Session busy**
   - Trigger `/compact` while a stream is active; expect "会话正在处理其他请求，请稍后再试。"

5. **Settings / Logs**
   - Open Settings → Models; simulate a list failure if possible; expect Chinese copy + retry.
   - Open Logs; simulate a query failure; expect Chinese copy + retry.

6. **Run the full quality gate**
   - `npm run check` (lint + typecheck + tests + web build).
   - `npm run desktop:build`.
   - Record screenshots of each failure state in `plans/desktop-e2e-test-plan.md`.

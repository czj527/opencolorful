# P1 Slice 1.5 Implementation Plan — Usability Hardening

**Date:** 2026-08-27
**Status:** Draft (awaiting author sign-off)
**Spec (authoritative product decisions, Chinese):** `docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md`
**Supersedes/extends:** `plans/p1-personal-assistant.en.md` (slice 1, merged PR #16-#23)

## 1. Goal

Fix the three blockers the author hit on first real-backend use: 25 dead settings controls, SSE streaming jank, and the half-defined "current agent" IA. Restore the desktop to a state where the I-group acceptance suite and the 5-day daily-use acceptance can actually run.

## 2. Evidence base (audits of 2026-08-27)

- **Dead controls:** 24 in `desktop/src/components/SettingsModal.tsx:51-120` (static config arrays rendered without handlers at :206-226) + 1 sidebar "每周记忆整理" button (`Sidebar.tsx:354-357`). 9 are pure missing wiring (endpoints exist), 3 are local display prefs misfiled as backend features, 13 are conceptually misplaced or unimplemented.
- **SSE jank:** per-token cascade — 1 SSE frame (`src/server/sse/session-events.ts:36-45`) → 1 IPC send (`desktop/electron/sse-proxy.cjs:105-108`) → O(n) full-array projection (`desktop/src/data/projector.ts:86-101,180-192`) → top-level `setItems` (`desktop/src/App.tsx:237-241`) → whole-tree re-render (`ChatView.tsx:176-185` maps all items; `MessageRow`/`EventRow` unmemoized; `App.tsx:454-496` recreates `assistantStatus`/`composerControls` per render).
- **Backend fact confirmed:** `GET /api/sessions` (`src/server/routes/sessions.ts:29-32`) already returns sessions across all agents; no new list endpoint needed. `Thread` (`desktop/src/mock-data.ts:13-21`) lacks `agentId` — must be added.
- **Supervisor trap:** `supervisor start` leaves desired-state=stopped, so the watchdog (correctly) never spawns the agent server; manual `POST /api/supervisor/start` required (`src/supervisor/app.ts:97`).

## 3. Task breakdown

| ID | Task | Owns (files) | Depends on | Type |
|---|---|---|---|---|
| T7 | SSE render performance | `desktop/src/data/ipc-source.ts`, `desktop/src/data/projector.ts`, `desktop/src/components/ChatView.tsx`, `desktop/src/App.tsx` (chat-state sinking only) | — | frontend |
| T11 | `supervisor start` auto-spawns agent server | `src/supervisor/` (lifecycle/desired-state), tests | — | backend, parallel-safe |
| T9 | Session-centric IA (D1+D5) + mock banner (D4a) | `desktop/src/components/Sidebar.tsx`, `desktop/src/App.tsx`, `ChatView.tsx` (header chip), new `ChatHeader` component + css, `desktop/src/data/source.ts` + `ipc-source.ts` + `mock-source.ts` (Thread.agentId, listThreads all-agents), `NewSessionDialog.tsx` (default agent + "新建助理…" entry), empty-state agent chips | T7 | frontend |
| T8 | Minimal settings page (D2) | `desktop/src/components/SettingsModal.tsx` (rewrite), new `desktop/src/data/local-prefs.ts` (localStorage), `ChatView.tsx` (consume show-thinking/show-tools filter) | T9 | frontend |

**Serial rationale (per development.md §2):** T7/T9/T8 all touch `App.tsx` and `ChatView.tsx`; parallel lanes would rebase-collide. Order chosen so the perf rework (T7) lands before structural IA (T9), and the settings rewrite (T8) lands last when both files are stable. T11 is backend-only and runs in parallel with T7.

### T7 — SSE render performance (spec D3)

1. **Batched notify in `ipc-source.ts:760-771`:** queue incoming envelopes per channel; leading event flushes immediately (first-token latency unchanged), subsequent events coalesce on a `requestAnimationFrame` (fallback 50 ms timer) trailing flush → one `applyEvent` pass over the queue, one `notify()` per frame.
2. **O(1) projector (`projector.ts`):** maintain `Map<string, number>` id→index and a cached pointer to the last streaming assistant message; `replaceItem`/`lastMessage` stop scanning. Keep the immutable-array contract for React (`items` identity changes once per flush, not per token).
3. **Component isolation:** `React.memo(MessageRow)`, `React.memo(EventRow)`; `useCallback` for `onOpenDiff` in App; `useMemo` for `assistantStatus` and `composerControls`.
4. **Sink chat state:** move `items`/`streaming` subscription out of `App.tsx` into `ChatView` (or a `ChatPage` wrapper) so streaming re-renders stay inside the chat column. `App` keeps only what the shell truly needs (streaming flag for Titlebar/assistantStatus — subscribe a narrow selector or lift via a tiny store; simplest honest approach wins, document choice in lane log).

**Verify:** `npm run check`; targeted vitest for projector (add O(1) regression tests: delta burst produces one snapshot per flush; order preserved; thinking/tool events unchanged); manual smoke: long streaming reply feels fluid.

### T11 — supervisor auto-start (spec D4b)

- `supervisor start` sets desired-state=running and spawns the agent server child (reuse existing spawn/watchdog path from #11 fix; `inferDesiredRunningFromState` semantics unchanged for adoption).
- CLI output tells the user both endpoints are coming up; `POST /api/supervisor/start` remains valid and idempotent.
- Tests: extend supervisor integration suite — after `start`, status reaches `agentServer.status=online` without manual POST; stop semantics unchanged (desired=stopped, no watchdog revival).

**Verify:** vitest supervisor suite green; manual: fresh terminals, `supervisor start` → `GET /api/supervisor/status` shows both online.

### T9 — Session-centric IA (spec D1, D4a, D5)

1. **Sidebar:** remove AgentCard + agent switcher menu + dead "每周记忆整理" row. Header keeps 新建会话 + settings. Thread rows gain an agent badge (avatar dot + agent name) — openhanako `AgentBadge` pattern. Grouping 进行中/最近/已归档 stays.
2. **Data source:** `Thread` gains `agentId`; `listThreads()` drops the agentId param (backend already returns all); mock source updated. `assistantStatus` derivation moves to per-session streaming + global connection.
3. **Chat header chip:** current session's agent shown as a compact ID-card chip (reuse `AgentCard` visuals, smaller); click → `AgentProfilePage` for that agent. Profile page route already exists (T0/T5).
4. **New-session default agent:** derive from most recent thread's `agentId`; zero threads → single agent auto-selected, multiple agents → empty state shows agent chips (openhanako WelcomeScreen pattern); `NewSessionDialog` agent selector preselects the derived default and gains a "新建助理…" inline entry (reuse T1 name+template form, calls `createAgent`).
5. **Mock banner (D4a):** when `source.info.mode === "mock"`, a prominent top banner: "当前为演示数据（后端未连接）". Sits under the titlebar, non-dismissable while in mock.
6. **`useFirstRun` unchanged** (still derived: no agents or no credentialed providers → onboarding).

**Verify:** `npm run check`; desktop build; manual: sidebar shows all sessions with agent badges, header chip → profile, new-session defaults sane in 1-agent and 2-agent setups, mock banner appears when backend down.

### T8 — Minimal settings page (spec D2)

1. **Rewrite `SettingsModal.tsx`** to four categories:
   - 外观: theme (existing wiring) + 减少动效 (localStorage pref, applies a `reduce-motion` class on root).
   - 模型与 Provider: existing provider list/form unchanged (already wired).
   - 对话显示: 显示思考事件 / 显示工具调用 toggles (localStorage prefs; consumed by `ChatView` to filter `EventRow` rendering — default: thinking on, tools on; document choice).
   - 关于: version / protocol / connection state as **read-only text**, not action rows.
2. **Delete** 通用/Agent/会话与工作区/记忆/Subagent/日志与诊断/插件与Skills/权限与安全 categories and the dead sidebar row. No hidden-but-rendered corpses.
3. **Backlog record** (in lane log + `plans/desktop-parity.md` wiring backlog): subagent default model, observability prefs, plugin enable UI, retrieval level, clear-memory, run limits/history.

**Verify:** `npm run check`; manual: every visible control does something real; prefs persist across reload; timeline filter actually hides/shows event rows.

## 4. Cross-cutting

- **Ledger:** `plans/desktop-e2e-test-plan.md` gains issues #17 (dead controls), #18 (SSE jank), #19 (IA confusion) + a wave-eight row executed after this slice lands (author re-runs affected I-group cases: I7 rewrites for new IA).
- **project-status.md:** priorities updated when the slice starts; status updated at close-out with evidence.
- **AGENTS.md doc-nav:** add spec row.
- **Lane logs:** one `plans/p1-tN-*.md` per task (established convention), including T7's chat-state-sinking design choice and T8's toggle defaults.
- **Quality gates per PR:** `npm run check` (CI) + docs-governance gate; each lane carries its plan/log file.

## 5. Acceptance (spec §4 condensed)

Fluid long-reply streaming (evidence: render-per-frame instrumentation or profiler), zero dead settings controls, self-consistent IA, mock banner + one-command backend, `npm run check` green, then author resumes I-group + 5-day daily use.

## 6. Explicitly out of scope

Virtualization, markdown rendering, IPC frame coalescing (re-evaluate after T7), backlog items listed in T8, slice-2 candidates (background-task visibility, mood with honesty review, compaction visibility). openhanako liveness layout notes (mood/thinking foldable blocks inside message stream; status ring at composer edge) recorded as slice-2 design material only.

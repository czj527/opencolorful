# P1 Slice 1.5 — T7: SSE Render Performance (spec D3)

**Lane:** T7 worktree (`D:\PI-study\.oc-lanes\t7`)
**Task code:** T7
**Status:** Implemented, verified (subagent evidence; main agent must re-verify)
**Spec:** `docs/superpowers/specs/2026-08-27-p1-slice-1.5-usability.md` §D3
**Plan:** `plans/p1-slice-1.5-usability.en.md` §3 T7
**Branch:** `feat/p1-t7-sse-perf`

## 1. Brief

Per-token SSE streaming jank: 1 SSE frame → 1 IPC send → O(n) projection → top-level `setItems` → whole-tree re-render. Four-part task, no behavior change, no new dependencies, desktop-only, no `electron/` or backend changes.

### Owned files (modified / created)

- `desktop/src/data/projector.ts` — O(1) id index + last-message pointer; array rebuild moves from per-event to per-flush.
- `desktop/src/data/ipc-source.ts` — per-channel leading+trailing batching of SSE events (rAF, 50 ms fallback).
- `desktop/src/components/ChatView.tsx` — `React.memo(MessageRow/EventRow)`; new `ChatView` container sinks the chat subscription.
- `desktop/src/App.tsx` — chat-state sinking only + memo/useCallback isolation (see §2.4 scope note).
- `tests/unit/desktop-projector.test.ts` **(new)** — projector O(1)/flush semantics regression tests.
- `plans/p1-t7-sse-perf.md` **(new)** — this document.

### Files reviewed but intentionally unchanged

- `desktop/src/data/mock-source.ts` — directly assigns `projector.items` (history seeding line ~98, `abort` line ~239) and bypasses the index; the projector self-heals instead (see §2.2 "Self-healing").
- `desktop/src/data/source.ts` — `subscribeChat` contract unchanged.
- `desktop/electron/*`, backend `src/server/*` — IPC frame coalescing explicitly out of scope (re-evaluate after T7 per plan §6).
- No new dependencies; no git commits/pushes (main agent commits).

## 2. Implementation Record

### 2.1 ipc-source: per-channel leading+trailing batching

Old hot path (`ensureEventRouter`): every frame → `applyEvent` + `notify` → one React flush per token.

New path (`enqueueChatEvent` + `scheduleFlush`):

- **Leading edge** — when no flush window is open, the incoming event is applied and notified immediately (`applyEvent` + `notify`), preserving first-token latency and instant `streaming` flips (turn started / session running).
- **Trailing flush** — applying the leading event opens a window (`channel.flushToken`); subsequent events in the same window are queued in `channel.pending` and flushed on the next `requestAnimationFrame` (fallback: 50 ms `setTimeout` when rAF is unavailable): all queued events applied **in arrival order**, then **one** `notify()`.
- **Per-channel isolation** — one `pending` queue + one flush token per `ChatChannel`; events for different channels (multi `subscribeChat`) never interleave.
- **Cleanup** — last unsubscribe cancels the flush token (`cancelAnimationFrame`/`clearTimeout`), drains `pending`, unsubscribes SSE, deletes the channel. No callback can fire for a dead channel (`flush` also no-ops on empty queue).
- `sendPrompt` optimistic user message and `markPromptFailed` still notify directly (discrete user actions, not SSE).

Worst case during dense streaming is 2 notifies/frame (leading + next-frame flush) instead of per-token; array rebuilds and React renders are amortized to frame rate.

### 2.2 projector: O(1) projection with flush-time array rebuild

`ProjectorState` gains `indexOf: Map<string, number>` (id → items index), `lastMessageIndex`, and `dirty`.

- `replaceItem`/upserts and `lastMessage` no longer scan: `indexById` is an O(1) map hit; a **self-healing** fallback does one linear scan and backfills the map only when the index is inconsistent (out-of-range or id mismatch — e.g. mock-source's direct `projector.items =` writes). The steady-state streaming hot path is pure O(1).
- **Immutable array contract preserved, rebuilt once per flush**: `applyEvent` mutates `state.items` in place (slot write via `setItemAt`, or `push` via `appendItem`) and sets `dirty`; `snapshotOf` (the only exit point; called by `notify`, i.e. once per flush) rebuilds `state.items = [...state.items]` when dirty. Changed item objects are fresh per event, so `React.memo(MessageRow/EventRow)` still re-renders exactly the changed rows while unchanged row objects keep identity.
- New `seedItems` replaces external wholesale assignment for history projection (ipc-source history load): rebuilds the index + last-message pointer.
- Order/snapshot semantics are byte-identical to the old scanner: appends at the end, in-place updates, `lastMessage` backward-scan semantics preserved (including the "history's last assistant is completed → delta appends a new message" behavior, verified by tests).
- `tool.delta`/`tool.completed` still scan the small per-tool rows array inside the tool event — that is not the items array and stays as is.

### 2.3 ChatView: memo rows + chat-state container

- `MessageRow` and `EventRow` wrapped in `React.memo` (module-level consts, `EventRow` keeps its internal expanded/approval state — memo only gates prop-driven re-renders).
- New `ChatView` container owns `items` state and the `subscribeChat` effect; renders `Timeline`. New-thread (`threadId === "new"`) resets items and reports `streaming=false`.

### 2.4 App.tsx: chat-state sinking + component isolation

**Design choice (documented per plan T7 §4):** App keeps a **narrow streaming-only subscription** — `subscribeChat(threadId, (snapshot) => setStreaming(snapshot.streaming))` — while items/complete snapshots are owned by `ChatView`. Rationale:

- `setStreaming` is the stable minimal channel: a `useState` setter's identity never changes and React bails out on unchanged values, so App re-renders **only on streaming boolean flips** — no custom store, no `useCallback` wrapper needed.
- Both subscriptions share the same `ChatChannel`; the channel stays alive while **either** handler is registered. This reproduces the old semantics where the top-level subscription never died on page switches: switching to memory/logs/profile mid-stream does **not** freeze the `streaming` flag or drop the SSE stream (ChatView's handler unsubscribes, App's narrow one keeps the channel + projector advancing); returning to chat re-attaches ChatView and immediately receives the fresh snapshot.
- A pure ChatView-owned subscription would freeze `streaming` and tear down the channel when the chat column unmounts on other pages — rejected as a behavioral change.

- Removed `items` state and the top-level full-snapshot subscription from App. `streaming` stays in App (Titlebar / assistantStatus / Composer / `send()` guard / usage-refresh effect — unchanged).
- `NEW_THREAD` resets `streaming=false` inside the same narrow effect branch.
- `onOpenDiff = useCallback(..., [])`; `assistantStatus` and `composerControls` are now `useMemo` hoisted before the early return (rules of hooks). `changeModel`/`changeThinkingLevel`/`changeToolMode` are `useCallback`d — without stable handlers the `composerControls` memo would recompute every render, defeating it; this is the minimal honest implementation of the plan's useMemo requirement.

## 3. Verification

### 3.1 Commands run (each with exit code)

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 2 — **pre-existing** failures only: `@opencolorful/plugin-protocol` has no `dist/` (package `types`→`./dist/index.d.ts`; never built in this fresh lane). All 148 errors are in files untouched by T7 (`src/`, `packages/plugin-sdk`, existing tests). **Zero errors in T7 files** (verified by grepping the error log for `desktop` — none). |
| `npx tsc -p tsconfig.build.json` | exit 0 |
| `npx vitest run tests/unit/desktop-projector.test.ts` | 11/11 passed |
| `npx vitest run tests/unit` | 1085 tests — 1 failed: `subagents-mailbox-coordinator` "failed 退避行未到期时重复 signal…" — **pre-existing flaky timing test**, identical code passes on untouched main clone (`D:\PI-study\opencolorful`, same file bytes since lane HEAD is an ancestor of main with no divergence). Flaky across runs (3 lane runs → 1 or 2 failures, different counts per run). |
| `npm run build --workspace=desktop` | exit 0 (`tsc --noEmit` + vite build, 1852 modules) |
| `git diff --check` | pass |

### 3.2 Projector regression tests added (11)

- delta burst within one window: items identity stable between applies, rebuilt only at `snapshotOf`; body concatenation; next window yields a fresh identity.
- streaming-only changes don't rebuild the array (`dirty=false` path).
- order preservation across mixed user/plan/assistant/recall messages (upsert-in-place, single instances).
- delta stream interleaved with thinking/tool lifecycle: positions, upserts, message pointer unaffected; turn completed finalizes message + thinking.
- repeated thinking/tool events upsert in place (no duplicates) — index correctness.
- out-of-order id scenario: tool created before message, tool updated after message → correct slots; second-turn delta append.
- empty delta ignored.
- `seedItems` (history load) rebuilds index + pointer; live delta after history appends to a new message (old semantics), then subsequent deltas concatenate onto it.
- external `projector.items =` overwrite (mock-source pattern) self-heals identically to the old linear scan.
- streaming flags via session.status / turn.* / error; prompt-failure path (optimistic user message kept, status event appended, streaming off).

## 4. Risks & deviations

1. **2 notifies/frame worst case** during very dense streaming (leading immediate + trailing flush) — inherent to the brief's leading+trailing spec; each notify is now O(1)-projected and rebuilds once. Strictly 1 render/frame would need pure trailing (first-token latency tradeoff) — rejected per brief.
2. **rAF pauses when the renderer is hidden/backgrounded** — queued deltas flush on refocus (rAF resumes); brief mandated rAF-first with `setTimeout` fallback only when rAF is *unavailable*, so no visibility-based fallback added.
3. **mock-source untouched** — its direct `projector.items =` writes are tolerated via the self-healing index (one scan, then steady O(1)); behavior stays identical to the old scanner (verified by dedicated test). If T9/T8 lanes clean up mock-source, the self-heal becomes dead code and can be removed.
4. **chat-state sinking** — App keeps a narrow streaming-only `subscribeChat` (per §2.4) so the channel stays alive across page switches and streaming transitions are preserved exactly; `items` live only in ChatView. `Timeline` (presentational) remains exported for potential tests. `ChatView`'s own NEW_THREAD branch is a defensive no-op (App never mounts it for `NEW_THREAD`).
5. **Root tsc gate blocked by environment** (`plugin-protocol` unbuilt). Main agent must confirm the quality gate's own build order (packages are presumably built before tsc in CI) — not caused by T7.
6. Recursion check on `changeModel` useCallback deps: `[isNew, source, threadId]` — `isNew` derives from `threadId`; kept explicit for clarity. No lint gate enforces exhaustive-deps in this repo.

## 5. Manual acceptance suggestions for the main agent

1. Non-empty real session: send a prompt; watch Titlebar go 运行中 immediately (`turn.started` leading), tokens stream fluidly; assistant message per-flush updates; clicked 在右侧审查 (file event) still opens the dock (`onOpenDiff` stable).
2. During streaming, empty-state navigation paths (new thread / agent switch) leave Titlebar idle (streaming reset).
3. Mock mode still streams its demo reply identically (mock-source parity via self-heal).
4. Optional: devtools CPU profile of a long reply — renders per frame, not per token.
# P1 Audit Remediation: SSE Batch Notification Dedupe

Status: COMPLETE (2026-09-07)
Audit source: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6 row 7 / §10 follow-up #6
PR: #74 (branch `audit-p1-74-sse-dedupe`)

## Goal

Close audit finding "SSE 合批中可能产生 N+1 次通知" (`desktop/src/data/ipc-source.ts:1182`).

## Non-Goals

- No change to the batching cadence (leading-immediate + rAF/50ms trailing window is kept).
- No change to projector apply semantics, branch-event handling, or replay behavior.
- No server-side change.

## Defect Analysis (source-verified)

The batching design (doc comment on `enqueueChatEvent`) promises: leading event applies and
notifies immediately (first-token latency), events arriving in the same frame are queued,
and the trailing flush applies all queued events **notifying once**. But `applyChatEvent`
called `this.notify(channel)` unconditionally per event, and the flush loop invoked it for
each queued event followed by one more trailing notify — N queued events produced **N+1
handler invocations** per flush. Each notify builds a fresh snapshot object, so React saw
N+1 state updates per frame, defeating the slice-1.5 batching optimization (合批节流).

## Fix

`desktop/src/data/ipc-source.ts`:

- `applyChatEvent` now only applies the event (and consumes a pending branch reload);
  notification is no longer inside it.
- `enqueueChatEvent` leading path notifies explicitly after applying (unchanged latency
  semantics).
- `scheduleFlush` trailing loop keeps applying per event and notifies exactly once after
  the batch (the documented intent).

## Tests

New `desktop/src/data/sse-batch-notify.test.ts` (3 cases, deterministic via a manual
requestAnimationFrame queue stub — no host-clock dependence). Placement note: the test
lives under `desktop/src/data/` next to the code under test because it exercises the
DOM-coupled `IpcDataSource`/`Window` types; `tsconfig.tests.json` is the Node-lib context
that explicitly excludes that family (see its exemption comment for
`branch-data.test.ts`), while the main `tsconfig.json` (DOM lib) covers `src/**` — so the
file is type-checked by the build gate without adding a new exclude entry.

1. Batch window with 4 queued deltas → exactly 1 leading + 1 trailing notification
   (defect produced 1 + 4 + 1); final snapshot contains all deltas (no event loss).
2. Empty flush (window closes with nothing queued) → no notification.
3. `turn.completed` inside the window still applies (streaming settles false) and the
   pending branch reload fires after the window (its notify is outside the batch, by
   design); notifications stay bounded.

Driven through the real `IpcDataSource.probe()` assembly chain with a stubbed
`window.desktopApi` (invoke/subscribeEvents/onEvent), the real event router, adoption
gate, and projector — not a test double of the batching itself.

Discriminating power verified empirically: restoring the per-event notify in
`applyChatEvent` makes 2 of 3 tests fail (count assertions); restored fix → 3/3.

## Verification

| Command | Result |
|---|---|
| `npx vitest run tests/unit/sse-batch-notify.test.ts` (desktop ws) | 3/3 passed |
| same, defect temporarily restored | 2/3 failed (discriminating) |
| `npx vitest run --root desktop` | 105/105 passed (102 + 3 new) |
| `npm run check` | all steps passed |
| `npx playwright test --config desktop/tests/e2e/playwright.config.ts` | 29/29 passed |

## Exit Criteria Met

- Trailing flush notifies exactly once; leading path unchanged; branch reload semantics
  preserved and covered.
- No secrets, no real provider network (stubbed IPC + fake api only).

## Known Deviations

- None. The extra notify removed was per-event inside flush; all boundary notifications
  (initial seed, history load, prompt optimistic, branch reload) are intentionally kept.

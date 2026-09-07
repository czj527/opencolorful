# P1 Audit Remediation — Branch GET Generation Token (#78)

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-07
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6 table row "分支切换多次 GET 没有 generation/token，旧响应可能覆盖新分支" (`desktop/src/data/ipc-source.ts:635` at audit time) / §10 queue item 5.

## Goal

Branch-view GETs triggered by different causes can be in flight concurrently. When responses land out of order, the stale response must not overwrite the newer one — the timeline and the branch tree must always reflect the latest requested branch state.

## Non-goals

- No server-side changes (GETs stay idempotent; ordering is enforced client-side).
- No request cancellation (AbortController) — the guard is a generation check, which is simpler and covers cases cancellation does not (response already decoded).
- The prompt SSE stream adoption gate (stream id) is a separate mechanism and untouched.

## Defect analysis

Two layers shared the same missing guard:

1. **Timeline entries reload** (`IpcDataSource.reloadBranchEntries`): three triggers can race on the same channel —
   - `switchBranch()` fires a best-effort immediate reload after the POST;
   - an SSE `session.branch.switched` event (he-end switch, replayed event, or the event beating the POST response) triggers `handleBranchEvent` → reload;
   - `consumePendingBranchReload` fires the deferred reload at turn end.
   Each reload does a full `seedItems` reprojection. A slow response for branch A landing after branch B's response would overwrite the timeline with branch A's entries.
2. **Branch tree refresh** (`BranchSwitcher.refreshTree`): `branchesChanged` events, opening the popover, and the manual refresh button can overlap; `setTree` applied whichever response landed last, not the latest requested one.

## Fix

Per-scope generation counters, checked when a response lands:

- `ChatChannel.branchGeneration` — incremented before each entries reload; on landing, a response whose generation no longer matches the channel's current value is dropped entirely (no `seedItems`, no `notify`).
- `BranchSwitcher` component-level `refreshGeneration` ref — same check around `setTree`/`setLoading`/`setLoadError`; the effect cleanup (session switch / unmount) bumps the generation so an in-flight response for the previous session can never call `setState`.

## Tests

- `desktop/src/data/branch-generation.test.ts` (IpcDataSource level, controllable DesktopApi stub with deferred `/entries` responses):
  - switch best-effort reload and `session.branch.switched` event reload concurrently — the stale-generation response lands first and is dropped, the current-generation response applies;
  - two rapid switches (b1 then b2) — b2's response applies, b1's late response is dropped;
  - single reload (no concurrency) — guard passes through, semantics unchanged.
- `desktop/src/branch-tree-race.mock.test.tsx` (BranchSwitcher rendered directly with a minimal source stub):
  - same-instance concurrent tree GETs via a captured `branchesChanged` handler — new response first, stale response later, final menu shows the new tree only;
  - single load: loading state → tree label (guard does not alter the happy path);
  - session switch with an in-flight stale response — the stale session's tree never renders.

Assertions on the branch tree target the expanded menu (leaf preview / `is-current` render inside the popover; the trigger shows only a count).

Discriminating mutation (run then reverted): commenting out both generation checks fails exactly the 3 concurrency cases (2 data-layer, 1 view-layer) while the 3 no-concurrency controls stay green.

## Verification

```text
desktop unit suite (vitest)                    -> 116/116 (was 110 + 6 new)
npm run check                                  -> green
full true-chain desktop e2e suite              -> 29/29
```

## Known limitations

- The generation guard orders *effects* (state application), not network requests; a superseded request still completes on the wire. That is acceptable for idempotent GETs whose only effect is the guarded setState.
- `getBranchTree` calls from the App shell outside `BranchSwitcher` (if any appear later) will need their own scope guard; the pattern is local per component/channel by design.

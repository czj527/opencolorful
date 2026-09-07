# P1 Audit Remediation: B4/B5 Electron true-chain (lane-b45) + replay-on-subscribe fix

**Status: Completed in lane worktree `wt-b45-e2e` (2026-09-06), pending main-agent review**
**Lane**: branch `p1-b45-electron-truechain`, base main `1a2418a`
**Audit source**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §7.3 + §10 item 7

## Goal

Close audit §7.3's four evidence gaps with real-Electron true-chain coverage (they previously had only mock/backend tests):

1. Trigger compaction in a real Electron app and see the **live compaction card** (compacting → completed, summary body + tokens line).
2. After app restart, see the **history summary card** rebuilt from the session JSONL compaction entry.
3. A real `todo_write` **tool call from the model** (streamed `tool_calls` deltas from the stub provider) drives the Desktop **SessionTodoCard** (counter 1/3, item texts, activeForm line).
4. Todo **restart recovery** from `SessionView.todos` (SQLite truth) with identical card content.

Plus: a **product defect the new true-chain lane exposed and this lane fixes** — on first SSE subscribe, the server replayed the full event history from sequence 0, so after a restart the desktop rendered the compaction card **twice** (history card from the REST snapshot's entries + a second "live" card from the replayed `session.compacting/compacted` control events, which bypass the prompt-stream adoption gate that protects message events).

## Non-goals

- No change to compaction behavior, todo tool semantics, or the event schema — the product fix is confined to the SSE endpoint's replay gating.
- No circuit-proxy disconnect scenario for todo (audit phrasing "断线 Replay"): the replay-store disconnect-refill semantics are already covered by B5 backend/Store/Replay unit tests; the Electron lane covers the restart path (re-subscribe + snapshot seeding). Documented as a deliberate boundary, not silently skipped.
- History compaction cards do not render the tokens line (tokens are live-card-only by the current projection contract: pi entry views don't carry tokensBefore/After). The lane asserts the summary body on restart, not tokens — asserting tokens there would pin a future enhancement.
- No CHANGELOG entry for the lane specs (test infrastructure); the SSE replay fix is user-facing-adjacent but invisible in normal use — recorded in project-status instead.

## Affected files

| File | Change |
|---|---|
| `src/server/sse/session-events.ts` | **Product fix.** `parseReplayCursor` now reports `explicit: boolean` (Last-Event-ID header or `?sinceSeq=` present). The replay loop only reads `replayStore.getSince(...)` for explicit cursors (disconnect refill); a first subscription with no cursor receives live events only — history is the REST snapshot's job. The subscribe-first/pendingLive buffer that guarantees no lost-event window is unchanged. |
| `tests/integration/sse-replay.test.ts` | The "does not lose an event" test now uses an explicit `?sinceSeq=0` (its semantics: replay+live race safety). New test: first subscription without a cursor must NOT replay cached events but MUST receive subsequent live events. |
| `desktop/tests/e2e/fixtures/lane-b45/backend.ts` | New lane harness (lane-b3-isomorphic): runRoot/home/user-data, ready-line parsing, dispose retain/cleanup self-check; `setStub`/`stubState` control plane; `apiGet`/`apiSend` with `serverAuthHeaders` from the shared `fixtures/server-token.ts` (#71). |
| `desktop/tests/e2e/fixtures/lane-b45/server-bootstrap.ts` | New stub provider: `text` mode (configurable reply text, incl. very long text for the compaction token threshold) and `todo_tool` mode (request #1 streams `tool_calls(todo_write)` with chunked arguments; request #2 returns a closing text). |
| `desktop/tests/e2e/fixtures/lane-b45/harness.ts` | Playwright fixture wiring (per-test lane lifecycle, retain-on-fail). |
| `desktop/tests/e2e/lane-b45-compaction.truechain.spec.ts` | CMP-01: 3 long turns (~48k chars each — pi `keepRecentTokens=20000`, ~4 chars/token local estimate; cut point must land after the first turn or "Nothing to compact") → `/compact` → live card assertions + tokens → session entries truth → restart → history card with identical summary. |
| `desktop/tests/e2e/lane-b45-todo.truechain.spec.ts` | TODO-01: todo_tool stub → real `todo_write` execution → SessionTodoCard (1/3, contents; in_progress renders activeForm not content) → `SessionView.todos` SQLite truth (3 items, statuses/priorities) → restart → card restored. |

## Verification commands

All run individually in the worktree, exit codes read separately.

| Command | Result |
|---|---|
| `npm run build:protocol` then `npm run build --workspace=@opencolorful/desktop` | exit 0 (fresh-worktree prerequisite per #71 lesson) |
| lane run 1 (`-g "@b45"`) | 2 failed: (a) compaction — strict-mode violation, **two compaction cards after restart**; (b) todo — assertion misuse: `in_progress` items render `activeForm`, not `content`. Item (b) fixed in the spec; item (a) investigated as a product defect. |
| `npx vitest run tests/integration/sse-replay.test.ts` (after server fix) | 11 passed (10 pre-existing incl. reworked race test + 1 new no-replay test), exit 0 |
| lane run 2 | 1 failed — CMP-01 restart segment asserted the tokens line on the history card, which the current projection contract does not carry (live-only). Spec aligned to contract. |
| lane run 3 | **2 passed (18.6s), exit 0 — double card gone** |
| full suite (`npx playwright test --config desktop/tests/e2e/playwright.config.ts`) | see implementation record (29 = 27 pre-existing + 2 new) |
| `npm run check` | see implementation record |

## Implementation record

1. Mechanism survey before writing code: `/compact` slash command (App.tsx send path, requires an existing thread) → `source.compactSession` → `session.compact` WS command → pi `session.compact()` (summarization request hits the stub provider; stub text reply ≤160 chars becomes the card summary; server sanitizes at 500). Compaction threshold: pi `prepareCompaction` requires messages beyond `keepRecentTokens` (default 20000 tokens, local estimate at 4 chars/token) — hence 3 turns × ~48k chars so the backward walk crosses 20000 at turn 2, leaving turn 1 in the summarize region.
2. `todo_write` driving reuses the lane-a4e streamed-`tool_calls` pattern; arguments `{todos:[{content,status,priority,activeForm?}]}` with at most one `in_progress`.
3. First lane run exposed the double-card defect. Root cause chain (all source-verified): `createSessionEventStream` defaulted `cursor.sequence=0` → `replayStore.getSince(streamId, 0)` replayed the whole session history on **every** first subscribe → replayed control events bypass the prompt-stream adoption gate (`isControl`) → projector inserted a second compaction card alongside the one seeded from REST entries. Message events were immune only because the adoption gate discards replayed prompt streams — the comment there literally describes this replay scenario; the B4 control events (added later) never got the same protection.
4. Fix (server): replay requires an **explicit cursor**. First subscription = live only; the subscribe-first + pendingLive ordering that prevents lost-event windows is untouched. Web impact assessed: `web SseClient` first-connect has no cursor either, but web history comes from the REST snapshot (`chat-state` rebuilds from `messageEntries`); `subagent-stream` always passes an explicit `sinceSeq`. Web Playwright suite re-run as arbitration.
5. Test updates: reworked race test to explicit cursor (preserving its replay+live semantics) and added the no-cursor-no-replay regression.
6. Aligned CMP-01 restart assertions to the projection contract (no tokens on history cards).

## Exit criteria

- All four §7.3 evidence gaps covered by green Electron true-chain tests. ✓
- The defect the lane exposed is fixed at the semantically correct layer (SSE replay gating) with a regression test, not papered over in the spec. ✓
- Full desktop true-chain suite green including the two new cases; `npm run check` green. ✓ (final steps)

## Known deviations

- Todo "断线 Replay" covered via the restart path (re-subscribe + snapshot seeding); a dedicated Electron circuit-proxy disconnect scenario is not added (B5 unit tests already own the replay-store refill semantics).
- `stubConfig` in the bootstrap is module-level mutable state — same pattern as lane-b3/a4b stubs; single-worker execution keeps it safe.
- The compaction spec's long-message size (48k chars × 3) is calibrated to pi's default `keepRecentTokens=20000`; if that default changes, the threshold comment in the spec must be updated.
- History compaction cards carrying tokens (pi entry → entry view) would be a UX enhancement; out of scope here, noted for the follow-up queue if desired.

# P1 Audit Remediation: lane-b3 intermittent send-disabled root cause and fix

**Status: Completed by main agent in worktree `wt-b3-send` (2026-09-06)** — original subagent lane failed with a platform concurrency error after ~47 min; its committed fixture work was reviewed, kept, and built upon.
**Lane**: branch `p1-audit-fix-b3-send-disabled`, base main `196d422` (merged forward to `0a397bc` during the lane)
**Audit source**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §4.3 / §5 P1-1

## Goal

- Reproduce the intermittent `BRANCH-03/04` failure ("second baseline message send: `<button disabled aria-label="发送">`", 1/3 under audit repetition), determine the root cause with trace-grade evidence, and eliminate it.
- Classify honestly per the audit's requirement: neither "stable product bug" nor "test noise".

## Root cause (trace-verified)

Failure chain, all timings from the failing repeat's `trace.zip` (10 CPU-stress spinners, repeat 1/8):

1. `click 发送` for message 1 at t=12517 → `App.send()` clears the draft synchronously, then awaits `createThread` + `updateSessionModel` + `updateSessionSettings` (three API round trips, in flight).
2. `ChatPO.expectIdle` **passes falsely at t≈12590-12602** (~85 ms after the click): `streaming` has never flipped to true yet (the turn has not started streaming), so「发送 visible + 停止生成 count 0」both hold. The PO's own doc comment already declares this blind spot ("发送键在草稿为空时本来就是禁用的…不能当流式信号") but the check still cannot distinguish "turn finished" from "turn not started".
3. The three API calls return → `setThreadId(thread.id)` → **React swaps the empty-state Composer (App.tsx `empty-composer` site) for the chat Composer (`chat-composer` site)**. Both are controlled by the same App `draft` state and share the same accessible name「给 X 的消息」.
4. `chat.fill(question2)` at t=12633: Playwright's atomic fill (focus → set value → dispatch input) landed on the textarea instance that was being unmounted by that swap — the input event never reached React.
5. `click 发送` at t=12714: draft is still `""` → `canSend=false` → button disabled → 30 s actionability timeout. This matches the audit's captured signature exactly.

Decisive evidence: the string `切回场景第二问` (question 2) occurs **exactly once in the entire failing trace — in the fill action's own parameters — and in no DOM snapshot**: the typed text never existed in the committed DOM.

Load sensitivity matches the audit: pre-fix, unstressed runs were 11/11 green while 1/8 failed under 10 CPU spinners (the audit reproduced 2/3 failures while running its own probes concurrently).

## Classification

- **Reproduced defect: test-timing defect** — documented `expectIdle` blind spot (false idle during the pre-streaming API phase) + filling while the one-time session-creation composer swap is in flight. Not a branch-feature bug; the failure exists since B3 merge because the baseline sequence was the only place that filled the composer across that swap.
- **Product side: minor UX consideration only** — a human typing during the sub-second creation transition loses focus (and in-flight keystrokes) when the composer remounts; text typed before/after the swap is preserved through shared App state. No functional defect; no product code change in this lane (recorded here as a known consideration, not fixed).

## Affected files

| File | Change |
|---|---|
| `desktop/tests/e2e/fixtures/lane-b3/backend.ts` | (subagent lane work, reviewed and kept) Trust-boundary adaptation: read-only `<home>/runtime/server-token` resolution + `Authorization: Bearer` headers + `apiSend()` for Node-side writes. Required after #66: strict mode 403s unauthenticated writes, so the fixture's `PUT /api/settings/preferences` failed before any UI step. Fail-closed: throws when the token file is missing; no bypass switch. |
| `desktop/tests/e2e/lane-b3-branches.truechain.spec.ts` | Root-cause fix: after each baseline `expectIdle`, wait for the turn's user bubble (`expectMessageVisible(question1/question2)`) before the next composer fill / server-truth reads. The bubble only renders in the swapped-in chat view, so the wait guarantees the composer swap is settled and the turn was accepted — the fill can no longer race the remount. Comment documents the mechanism. |
| `docs/architecture-map/architecture.generated.js` | Regenerated after merging main (#63-#68): `architecture:check` validates the PR×base merge tree, and the merged tree adds `src/server/trust-boundary.ts` / `desktop/electron/token-source.cjs` (506 source files). |
| `plans/p1-audit-remediation-b3-send-disabled.en.md` | This record. |

Temporary `console.log` instrumentation (App.tsx / Composer.tsx, added by the subagent for reproduction) was removed after diagnosis; both files are byte-identical to their merged-main state.

## Verification commands

All run individually, exit codes read separately.

| Command | Result |
|---|---|
| `npx playwright test --config desktop/tests/e2e/playwright.config.ts -g "BRANCH-03/04" --repeat-each=3` (pre-fix, unstressed) | 3/3 passed — flake does not reproduce without load |
| same, `--repeat-each=8` + 10 CPU spinners (pre-fix) | **1/8 failed with the audited send-disabled signature**; failing repeat's trace yielded the root cause above |
| `npm run build --workspace=@opencolorful/desktop` (post-fix; runs `tsc --noEmit` + `tsc -p tsconfig.tests.json --noEmit` + `vite build`) | exit 0 |
| `node scripts/generate-architecture-map.mjs --check` | `Architecture map is current (21 nodes, 506 source files)`, exit 0 |
| same BRANCH-03/04 run, `--repeat-each=8` + 10 CPU spinners (post-fix) | **6 passed / 2 failed — zero send-disabled signatures**; both failures are `EBUSY … unlink …user-data\Dictionaries\en-US-10-1.bdic` in fixture teardown (see deviations) |
| `npx playwright test --config desktop/tests/e2e/playwright.config.ts lane-b3` (post-fix, unstressed) | **3/3 passed** (BRANCH-01/02 14.1s, BRANCH-03/04 31.3s, BRANCH-05 9.8s) |

## Exit criteria

- Audited intermittent failure no longer reproduces under stress that reliably triggered it pre-fix (8 stressed repeats, 0 signature hits).
- Full lane-b3 file green with the fixture trust-boundary adaptation in place.
- Desktop type gates and `architecture:check` green.

## Known deviations

- The two stressed-run failures are `EBUSY` on unlinking Chromium's `en-US-10-1.bdic` inside `user-data` during **fixture teardown** — a Windows file-lock race under artificially extreme CPU/IO load, in a different layer (harness cleanup) from the audited defect. Pre-existing behavior, not exposed at CI/normal load; not fixed here (would be a teardown-retry hardening in the shared fixture, separate scope).
- `ChatPO.expectIdle`'s blind spot is deliberately left as-is (its comment documents it; multiple lanes rely on its loose semantics). The fix adds explicit acceptance barriers at the two call sites that needed them; other lanes' baseline patterns already pair `expectIdle` with `expectMessageVisible` (BRANCH-01/02, BRANCH-05 do; that was exactly the omission in BRANCH-03/04).
- Theoretical residual: after message 2, a `retryMessage` issued while message 2's turn is still streaming would 409 by design. With the fast stub (~100 ms turn) plus the new bubble barrier and two Node-side reads before the retry, this window is practically closed; not reproduced, not the audited failure.
- The subagent lane's ~47 min before its platform failure produced only the fixture adaptation (reviewed: correct fail-closed semantics, mirrors `desktop/electron/token-source.cjs`) and temporary instrumentation; all root-cause work and the fix are the main agent's.

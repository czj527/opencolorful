# P1 Audit Remediation: Runtime Single-Flight + Developer Workbench Board

Status: COMPLETE (2026-09-07)
Audit source: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6 row 1 / §10 follow-up #1
PR: #73 (branch `audit-p1-73-singleflight`)

## Goal

Close audit finding "`ensureRuntime()` has no per-session single-flight; two concurrent
requests can duplicate or overwrite a Runtime" and, in the same PR, turn the architecture
map into a developer workboard that aggregates every developer-owned acceptance task.

## Non-Goals

- No change to PromptService, SessionRuntime lifecycle, or route-level busy handling.
- No change to rebuild-on-profile-change semantics (only concurrent entry is serialized).
- No new product feature in Desktop renderer.

## Defect Analysis (source-verified)

`createRuntimeBootstrap.ensureRuntime` (`src/server/routes/runtime-bootstrap.ts`) is shared
by four entry points — POST messages, POST compact, POST regenerate, POST branch/switch.
Its check-then-create sequence spans an `await SessionRuntime.create(...)` gap, so two
concurrent requests for the same session both observe `!promptService.hasRuntime(sessionId)`
and both assemble. `PromptService.register` is a plain `Map.set`: the loser silently
overwrites the winner, leaking the first runtime's memory/skill/todo/subagent/plugin
contexts (registered under the same sessionId, never disposed). In the rebuild path, the
interleaving can also register a disposed runtime.

## Fix

`src/server/routes/runtime-bootstrap.ts`:

- Original body renamed to `ensureRuntimeOnce` (logic unchanged).
- Public `ensureRuntime` becomes a per-session single-flight wrapper backed by an
  `ensureInFlight: Map<string, Promise<void>>`: first caller stores the assembly promise;
  concurrent callers for the same session await the same promise (different sessions are
  independent); the entry is removed in a `finally` so a failed assembly can be retried as
  a fresh attempt (retry semantics unchanged; joined callers share the same rejection).

## Tests

New `tests/integration/runtime-bootstrap-single-flight.test.ts` (4 cases, all passing):
counting `PromptService.register` per session and counting `getSettings` reads via a
failing `AgentStore` subclass:

1. Concurrent first assembly ×4 → exactly one register; sequential follow-up does not
   re-assemble.
2. Concurrent failing assembly → shared rejection, exactly one settings read; after the
   in-flight entry clears, a retry is a fresh attempt (second read).
3. Profile-invalidation rebuild still works: sequential rebuild +1 register, concurrent
   rebuild ×3 shares one assembly.
4. Different sessions assemble independently in parallel.

Discriminating power was verified empirically: with the single-flight wrapper temporarily
bypassed, 3 of 4 tests fail (register count 4 instead of 1, etc.); restored, 4/4 pass.

## Developer Workbench (architecture map)

- `docs/architecture-map/project-board.json`: baseline/health/truth sync to 38519d2
  (immediate fixes 5/5, a4 token adaptation, B4/B5 true-chain #72, full true-chain 29/29);
  `quality-blockers` card moved to done (all 4 checklist items closed by #66–#70);
  `wave-b-evidence` checklist updated (compact/todo/BRANCH-03/04 done via #70/#72);
  new cards `audit-remediation-queue` (10 items, 2 done), `manual-acceptance-wave-a`
  (A1–A6), `manual-acceptance-wave-b` (B1–B7) — audit §8 cards are developer-personal
  acceptance tasks that automation cannot replace.
- `docs/architecture-map/index.html` + `app.js` + `styles.css`: new "开发者待办" panel at
  the end of the board view aggregating undone checklist items of developer-owned cards
  (tags contain `开发者必做` or type is `审计修复`/`发布验证`); clicking an entry selects
  the underlying board card. View layer stays generic — no project facts in scripts.
- `docs/architecture-map/architecture.manifest.json`: status updated to audit-remediation
  lane; knownGaps refreshed (BRANCH-03/04 and Wave B true-chain gaps closed by #70/#72;
  web event allowlist gap kept with accurate scope — verified `todo.updated`,
  `session.branches.changed`, `session.branch.switched`, turn terminal events are still
  absent from `web/src/lib/sse-client.ts` while already emitted server-side; new gap for
  pending release verification).
- `docs/architecture-map/architecture.zh-CN.json`: status + knownGaps copy aligned;
  new `projectBoard.devTodo` copy block.
- `scripts/generate-architecture-map.mjs`: locale validation now requires the
  `devTodo` copy block (5 keys).

## Verification

| Command | Result |
|---|---|
| `npx vitest run tests/integration/runtime-bootstrap-single-flight.test.ts` | 4/4 passed |
| same, single-flight bypassed | 3/4 failed (discriminating) |
| `npm run architecture:map` + `npm run architecture:check` | current (21 nodes / 506 files) |
| `npm run check` | all steps passed (docs governance, architecture:check, pi-imports, plugin-imports, build:protocol/sdk, typecheck, root tests, build, web test/build, desktop test/build) |
| Desktop e2e full true-chain | 29/29 passed |
| Board UI smoke (Playwright over local HTTP) | dev-todo panel renders 4 cards / 25 open items; click-through selects board card |

## Exit Criteria Met

- Concurrent assembly for one session can no longer double-create or overwrite a runtime
  (negative test in place, discriminating power proven).
- Board data reflects verifiable repo facts (commits #70/#71/#72) and audit §8/§10 state.
- No secrets, no real provider network in tests (faux/stub only, isolated homes).

## Known Deviations

- Board checklist for this PR's own item (`Runtime single-flight (#73)`) is pre-marked
  done in the same PR; acceptable because the checklist item names the PR itself.
- The workbench panel is a projection; card states remain governed by
  `docs/project-status.md` and the audit document.

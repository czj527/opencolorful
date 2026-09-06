# P1 Audit Remediation: a4 lane fixture token adaptation (#66 follow-up closure) and full true-chain 27/27

**Status: Completed in lane worktree `wt-a4-token` (2026-09-06), pending main-agent review**
**Lane**: branch `p1-a4-fixture-token`, base main `a726090`
**Audit source**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §10 follow-up queue first item; `docs/project-status.md` 2026-09-06 full-suite rerun entry (9/27, 12 direct 403s)

## Goal

- After #66 (local HTTP/WS trust boundary) landed, the Node side of the five a4 lanes (a4a/a4b/a4c/a4d/a4e) still issued **bare write requests** (POST/PUT/DELETE) to the Agent Server — every provisioning/preference call was rejected with HTTP 403 in strict mode. The full desktop true-chain suite dropped to 9/27 (12 failures with the error directly `HTTP 403`).
- Adapt every Node-side write call site in the five lanes to the trust boundary, the same fail-closed way lane-b3 was adapted in #69: read the server token from `<home>/runtime/server-token` (same path/semantics as `desktop/electron/token-source.cjs` and `resolveServerToken`), send `Authorization: Bearer <token>`, and **throw when the token is missing** — no bypass, no skip flag.
- Re-run the full desktop true-chain suite and require 27/27 before claiming the "真链 26/27→27/27" and audit AUTO_PASS gaps closed.

## Non-goals

- No change to the trust boundary itself or to any product code (`src/`, `desktop/src`, `desktop/electron`) — this lane is test-fixture-only.
- No refactor of `fixtures/lane-b3/backend.ts`: it keeps its lane-local private token implementation, consistent with the lane-local fixture philosophy documented in its header ("结构与共享 backend.ts 同构…lane 本地实现"). The new shared helper is used by a4 lanes; deduplicating b3 is left as an optional cleanup, not mixed into this defect fix.
- No change to the a4b circuit proxy: it forwards app requests header-for-header (the Electron main already attaches the token via #66 wiring) and rewrites only `Host`, which satisfies the boundary's Host check.
- Read calls (`apiGet`, SSE subscribes) stay tokenless — the boundary only requires a token for non-GET/HEAD/OPTIONS methods (`READ_METHODS` in `trust-boundary.ts`).
- Stub/proxy control planes (`/__a4b__/`, `/__b3__/`, `/__a4e__/`) are lane-local test servers, not the Agent Server — outside the trust boundary, unchanged.
- No CHANGELOG entry: test infrastructure only, not user-visible.

## Affected files

| File | Change |
|---|---|
| `desktop/tests/e2e/fixtures/server-token.ts` | **New.** Shared helper: `readServerToken(homeDir)` (read-only, null on missing) + `serverAuthHeaders(homeDir)` (throws when token missing — fail-closed). Mirrors `token-source.cjs` path semantics. |
| `desktop/tests/e2e/fixtures/lane-a4a/api.ts` | `apiSend` now takes the harness (`BackendHarnessLike { serverUrl; homeDir }`) instead of a bare `serverUrl`, and always attaches `serverAuthHeaders(harness.homeDir)`; `content-type` added only when a body exists (bodyless DELETE needs no Content-Type per the boundary). |
| `desktop/tests/e2e/fixtures/lane-a4a/provision.ts` | 3 call sites pass `harness` instead of `harness.serverUrl`. |
| `desktop/tests/e2e/lane-a4a-workspace.truechain.spec.ts` | 1 call site (PUT session settings negative case) passes `harness`. |
| `desktop/tests/e2e/lane-a4a-session.truechain.spec.ts` | 2 bare `fetch` writes get the token header: archive DELETE + preferences PUT (SESS-04/SESS-05). |
| `desktop/tests/e2e/fixtures/lane-a4d/api.ts` | Same shape change as lane-a4a/api.ts. |
| `desktop/tests/e2e/fixtures/lane-a4d/provision.ts` | 2 call sites pass `harness`. |
| `desktop/tests/e2e/lane-a4d-memory.truechain.spec.ts` | 1 call site (deep-dive POST) passes `harness`. |
| `desktop/tests/e2e/fixtures/lane-a4e/backend.ts` | `apiSend` method attaches `serverAuthHeaders(this.homeDir)`. |
| `desktop/tests/e2e/lane-a4b-abort.truechain.spec.ts` | `pinDefaultModelToStub` bare PUT gets the token header. |
| `desktop/tests/e2e/lane-a4b-chat.truechain.spec.ts` | Same as abort spec. |
| `desktop/tests/e2e/lane-a4c-provider-settings.truechain.spec.ts` | `pinDefaultModel` bare PUT gets the token header; harness param type widened to `{ serverUrl; homeDir }`. |

Completeness sweep (evidence this is exhaustive): `grep -n "fetch(\|apiSend\|apiGet"` over all `lane-*.spec.ts`, `smoke.truechain.spec.ts`, and `fixtures/**` — the only Agent-Server writes were the 7 call sites listed above plus lane-b3/a4e backend methods (b3 already adapted in #69, a4e adapted here). All remaining `fetch` hits are GET/SSE reads or `__a4b__`/`__b3__`/`__a4e__` stub control planes.

## Verification commands

All run individually in the worktree, exit codes read separately.

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.tests.json` (desktop, fresh worktree before package builds) | exit 2 — all `Cannot find module '@opencolorful/plugin-protocol'` / missing-export errors: fresh-worktree environment artifact, unrelated to this change |
| `npm run build:protocol` | exit 0 |
| `npx tsc --noEmit -p tsconfig.tests.json` (after protocol build) | exit 0 |
| full suite run 1: `npx playwright test --config desktop/tests/e2e/playwright.config.ts` | **1 passed / 26 failed (38.6m)** — root cause: fresh worktree had no renderer `dist/` (Electron loads `dist/index.html`); uniform ~35s early failures + 3.0m timeouts across every lane, unrelated to tokens. The one pass was WS-03 negative, whose `apiSend` PUT now reaches the business 400 (would be 403 pre-fix) — positive signal for the token adaptation |
| `npm run build --workspace=@opencolorful/desktop` (dual tsc + vite build) | exit 0 |
| full suite run 2 (same command after build) | **27 passed / 0 failed (8.2m), exit 0** — gate satisfied |
| `npm run check` (final gate) | see implementation record |

## Implementation record

1. Confirmed the boundary contract from source: `READ_METHODS = GET/HEAD/OPTIONS` (tokenless); strict-mode writes need a valid token, plus `application/json` Content-Type only when a body is present (`hasRequestBody` gate) — so bodyless DELETE needs the header but no Content-Type.
2. Created the shared `fixtures/server-token.ts` helper (fail-closed throw on missing token; no bypass).
3. Adapted lane-a4a/a4d `apiSend` to take the harness (structural `BackendHarnessLike` to avoid a circular import with `../backend.js`), updated all 9 call sites across provision files and specs; adapted a4e `apiSend` in place; added token headers to the 4 bare `fetch` writes in a4a-session/a4b-abort/a4b-chat/a4c specs.
4. Ran the completeness sweep (grep over all specs/fixtures) proving no further Agent-Server writes exist outside the adapted call sites.
5. First full-suite run failed 26/27 with uniform early failures; diagnosed (via `desktop/tests/e2e/fixtures/app.ts` header docs) that the fresh worktree lacked the renderer `dist/` build — an environment gap, not a code defect. Built the desktop package; second run: **27/27 in 8.2 minutes**.
6. Updated `docs/project-status.md`: baseline, new closure entry, priority #1 rewritten to the audit §10 follow-up queue.

## Exit criteria

- All Node-side write paths in a4a–a4e carry the trust-boundary token and fail closed when it is missing. ✓ (code sweep + typecheck)
- Full desktop true-chain suite 27/27 locally. ✓ (run 2)
- `npm run check` green including the governance gate (this file) and `architecture:check`. ✓ (final step of this lane)

## Known deviations

- **Fresh-worktree e2e prerequisite learned the hard way**: a new worktree must run `npm run build:protocol` and build the desktop package before the true-chain suite; otherwise every lane fails at Electron renderer load. Recorded in project-status and worth adding to onboarding docs later.
- `lane-b3/backend.ts` keeps its own token implementation (deliberate, see Non-goals). The shared helper duplicates ~15 lines of the same semantics rather than b3 importing it — drift risk is bounded by both being exercised in the same full-suite run.
- `BackendHarnessLike` is a new structural type in both lane api.ts files (identical shape). A future cleanup could lift it into `fixtures/backend.ts`; kept local here to avoid touching the shared harness file for a type-only concern.
- Run 1's 1/26 result is retained in this record because it documents both the environment gap and the WS-03 negative-case improvement (business 400 reached instead of boundary 403) that the token fix produced.

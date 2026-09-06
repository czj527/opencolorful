# P1 Audit Remediation: Agent Settings Read Failure Must Fail Closed

**Status:** 已完成（lane 实施记录，待主 Agent 独立复核）
**Date:** 2026-09-06
**Baseline:** `main` at `15036b7`; lane branch `p1-audit-fix-agent-settings-fail-closed`（单 lane 提交）
**Audit source:** `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6（源码级风险表第 2 行，P1）
**Evidence location:** `src/server/routes/runtime-bootstrap.ts`（修复前约 351-363 行）

## 1. Goal

Eliminate the confirmed fail-open defect: when a Session is bound to an Agent and
`AgentStore.getSettings()` throws, the Runtime bootstrap previously swallowed the
error and continued creating the Runtime **without sandbox configuration**
(`agentSettings`/`agentHomeDir`/`platformHome` all stayed `undefined`, so
`SessionRuntime.create` skipped `SandboxService` entirely). Agent settings carry
the sandbox capability set (`extraReadPaths`/`protectedPaths`, see
`src/contracts/agent-settings.ts`), so a silent degrade means an Agent-bound
session running with no path sandbox.

Fix: a settings read failure for an Agent-bound session now throws
`EnsureRuntimeError` with a stable `ApiError`; no Runtime is created.

## 2. Non-goals

- No change to `AgentStore` internal tolerance (`readSettings` still falls back
  to defaults for a corrupted-but-readable `settings.json`; that is store-level
  data-repair behavior, not a runtime assembly boundary).
- No change to the persona assembly path (`buildSystemPrompt` → `getBaseColor`),
  whose failures are already fail-closed via the existing outer mapping
  (`500 SESSION_ERROR "无法创建 Session Runtime"` in the creation path).
- No change to documented optional-capability degrades (memory/skill/todo/
  subagent/plugin context registration); see §7 inventory.
- No single-flight/concurrency work for `ensureRuntime` (audit §6 row 1, separate risk).
- No `package.json`/`CHANGELOG.md`/`docs/project-status.md` edits (main agent consolidates).

## 3. Affected files

| File | Change |
|---|---|
| `src/server/routes/runtime-bootstrap.ts` | Replace the silent `catch` around `agentStore.getSettings` with `throw new EnsureRuntimeError(createApiError("SESSION_ERROR", "Agent 设置读取失败，已拒绝启动运行时"), 500)` |
| `tests/integration/runtime-bootstrap-agent-settings-fail-closed.test.ts` | New regression tests (4 cases) |
| `plans/p1-audit-remediation-agent-settings-fail-closed.en.md` | This governance record |

## 4. Design decision: HTTP status and error boundary

- **Status `500` with code `SESSION_ERROR`.** The `EnsureRuntimeError` contract
  limits status to `409 | 500`. The repo's existing convention in this file:
  `409 CONFLICT` is used for *not-ready / user-actionable* states ("Session
  Runtime 未就绪", "当前 Session 未选择主对话模型"), while server-side assembly
  failures map to `500 SESSION_ERROR` ("无法创建/重建 Session Runtime"). A
  settings read failure for a bound Agent is a server-side data-integrity
  failure (agent directory missing/corrupted/unreadable on disk while a live
  session references it) — not transient and not resolvable by the caller
  through this endpoint. The lane brief allows `500` when the semantics are a
  server-side integrity failure; the repo has no `503` convention in
  `EnsureRuntimeError` (the type union forbids it). Rationale recorded here per brief.
- **Error copy:** `Agent 设置读取失败，已拒绝启动运行时` — Chinese, stable,
  echoes no agent id, no paths, no exception details (the original error message
  is intentionally discarded).
- **Boundary: "component unavailable" vs "read failure".** `agentStore === undefined`
  or `paths === undefined` (composition root did not inject them, e.g. minimal
  test harnesses or alternative deployment shapes) is treated as a legal
  configuration and keeps the current behavior (no sandbox block executed, the
  pre-existing `409 "Session Runtime 未就绪"` still guards the missing
  `sessionService`/`paths` creation case). Only the *bound-and-available-but-
  read-throws* case is fail-closed. Mixing these two would break harnesses that
  legitimately run without an AgentStore.

## 5. Verification (all commands run separately, exit codes read)

| Command | Result |
|---|---|
| `npx vitest run tests/integration/runtime-bootstrap-agent-settings-fail-closed.test.ts` | exit 0 — 1 file passed, 4/4 tests passed |
| `npx vitest run` (root, full, default timeouts) | exit 1 — 2278/2279 passed, 1 pre-existing environment failure unrelated to this lane (see below and §6) |
| `npx vitest run --hookTimeout=120000` (root, full) | exit 0 — 194/194 files, 2279/2279 tests |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run check` | see §6 for the recorded outcome (it runs the full suite again with default timeouts) |

**Pre-existing environment failure (not this lane's):** with default timeouts,
`tests/unit/skills/detect-path-bins.test.ts > 全 PATH 上限 5000` fails on this
host — the test's own assertions pass, but its `afterEach` cleanup hook
(`fs.rmSync` of ~5000 temp files) exceeds vitest's default 10s hook timeout
(test alone runs ~26s on this machine). Evidence that it is independent of this
lane: (a) the test imports only `src/runtime/skills/composition.js`, which has
no import-path overlap with `runtime-bootstrap.ts`; (b) with the lane's fix
reverted (base behavior), the same test fails identically; (c) it passes with
`--hookTimeout=120000`.

## 6. Implementation record

- 2026-09-06: read audit §6 row 2, `runtime-bootstrap.ts` full text, `AgentStore.getSettings`,
  `EnsureRuntimeError` consumers (`messages.ts`, `session-branches.ts` — both map
  `error.apiError`/`error.status` directly), and existing test organization
  (`tests/integration/session-branch-bootstrap.test.ts` is the established
  runtime-bootstrap regression home).
- Applied the fail-closed edit (single `catch` → `EnsureRuntimeError`).
- Inventory of same-pattern silent catches in `runtime-bootstrap.ts` (see §7): only
  the audited one is a critical-assembly fail-open; others kept with rationale.
- Added regression tests. Test placement follows the existing bootstrap test
  (`tests/integration/`), see §8 deviation D1.
- Verification results (sequential, each command separate):
  - New test file: exit 0, `Test Files 1 passed (1)`, `Tests 4 passed (4)`.
  - `npx vitest run` (full, default timeouts): exit 1 — `Tests 1 failed | 2278
    passed (2279)` across 194 files. The single failure is the pre-existing
    `detect-path-bins` cleanup-hook timeout described in §5; proven unrelated to
    this lane by the revert experiment (fails identically at base behavior) and
    by the import-graph check.
  - `npx vitest run --hookTimeout=120000` (full): exit 0 — `Test Files 194
    passed (194)`, `Tests 2279 passed (2279)`.
  - `npx tsc --noEmit -p tsconfig.json`: exit 0.
  - `npm run check`: recorded below (it re-runs the full suite with default
    timeouts, so the §5 environment failure may reproduce; every other gate in
    the chain must pass).

## 7. Same-pattern silent catch inventory (runtime-bootstrap.ts and adjacent assembly)

| Location | Degrade behavior | Verdict |
|---|---|---|
| `getSettings` catch (the audited one, ~L355) | Runtime continues without sandbox | **Fixed** (fail-closed) |
| `buildPluginSessionTools` catch → `[]` (~L129) | Plugin tools dropped on facade error; plugin *execution* remains fail-closed (turn snapshot P0/P1-2 refuses unfrozen invokes) | **Kept** — documented optional capability ("插件系统异常时降级为空"); degrade reduces capability, not a security boundary |
| `pluginSignature` catch → `""` (~L252) | Signature computation failure treated as "no plugin state" | **Kept** — affects rebuild scheduling only; execution layer fail-closed; not sandbox/memory assembly |
| `setupMemoryContext` catch (~L394) | Memory context not registered | **Kept** — memory tool invocation is fail-closed per session (`memory-tools.ts` exact-match registry, refuse when unregistered); capability, not sandbox |
| `setupSkillContext` catch (~L425) | Skill context not registered | **Kept** — same fail-closed invocation contract (`skill-tools.ts`) |
| `setupTodoContext` catch (~L446) | Todo context not registered | **Kept** — same fail-closed invocation contract (`todo-tools.ts`) |
| `setupSubagentContext` catch (~L692) | Subagent context not registered | **Kept** — same pattern; delegation itself fail-closed (freeze failures refuse spawn) |
| `parentSnapshot` skill capture catch → `[]` (~L552) | No skill delegation on capture failure | **Kept** — fail-closed in the restrictive direction (delegates fewer, never more) |
| `getSessionState` catch → `"deleted"` (~L686) | Session state probe failure treated as deleted | **Kept** — restrictive direction (subagent parent ops refused) |
| `app.ts` `memorySettingsResolver` catch → global default (~L163) | Per-agent memory budget falls back to global default | **Kept** — documented (评审 P1#7b) capability fallback; with this fix, the same `getSettings` failure now fails the runtime before memory budget matters for bound sessions |

Adjacent assembly (`messages.ts`, `session-branches.ts`, `app.ts`, `SessionRuntime.create`):
no additional catch-degrade of "Agent-bound critical assembly" found. Note (kept as-is):
in the runtime-rebuild path, `buildSystemPrompt` runs outside a `try` and its failure
propagates as a raw error (route outer catch → `409 "Session 当前无法接受 Prompt"` in
messages POST). That is fail-closed (no rebuild happens, old runtime retained), only
less precisely coded — not a fail-open, therefore out of scope.

## 8. Known deviations and residual risk

- **D1 — test placement.** The lane brief suggested `tests/unit/`, but the
  established runtime-bootstrap regression organization is
  `tests/integration/session-branch-bootstrap.test.ts` (the brief itself says to
  follow it), and these tests require the full service graph (SQLite, SessionService,
  HTTP app, AuditRecorder — session creation is audit-gated fail-closed). Placed in
  `tests/integration/runtime-bootstrap-agent-settings-fail-closed.test.ts`.
- **D2 — reachability note (honesty, not a softening).** With a real `AgentStore`,
  `getSettings` and `getBaseColor` both start with `readIdentity`, so in the
  first-creation path an unreadable agent usually surfaces first through the
  persona path's outer `500` mapping. The repaired catch remains a real fail-open
  (TOCTOU between the two calls, subclasses/alternative stores, and any future
  reorder), and the audit confirmed it as a risk. The regression test uses a
  store whose `getSettings` throws while other reads succeed, so the fixed path
  is exercised directly and the stable error contract is asserted, not the
  incidental outer fallback.
- **R1 — residual risk.** Sessions already bound to an agent whose data directory
  is deleted/corrupted will now surface `500 SESSION_ERROR` on the next prompt
  instead of silently running unsandboxed. This is the intended behavioral change;
  user-facing recovery (rebinding/re-creating the agent) is a product concern
  outside this lane.

## 9. Exit criteria

- [x] `getSettings` failure for a bound session rejects runtime creation with a
      stable error (code `SESSION_ERROR`, Chinese stable copy, no internal detail).
- [x] Readable settings: behavior identical to pre-fix (runtime created, turn completes).
- [x] Sessions without agent binding are unaffected (even with a broken `getSettings`).
- [x] Full root vitest suite green with `--hookTimeout=120000` (194 files /
      2279 tests); with default timeouts the only failure is the pre-existing
      `detect-path-bins` cleanup-hook timeout documented in §5 (unrelated to
      this lane, proven by revert experiment).
- [x] `tsc --noEmit` clean.
- [ ] `npm run check` outcome recorded in §6 (other gates must pass; the §5
      environment failure may reproduce at the test step).
- [ ] Main agent independently re-reviews diff and re-runs the quality gate.

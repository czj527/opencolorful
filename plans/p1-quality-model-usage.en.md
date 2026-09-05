# P1 Wave A: Quality System, Two-Tier Models, and Unified Usage

**Status:** 规划中  
**Date:** 2026-08-31  
**Authoritative product spec:** [`docs/superpowers/specs/2026-08-31-p1-quality-model-usage.md`](../docs/superpowers/specs/2026-08-31-p1-quality-model-usage.md)  
**Current status:** [`docs/project-status.md`](../docs/project-status.md)  
**Baseline fact:** `main` at `084414c` after A0 closeout (PR #40/#41/#42); the cwd fallback and preferences persistence fix are now part of the baseline.

## 1. Scope and non-goals

This is a P1 internal implementation wave. It does not create a new product phase. The wave establishes a repeatable module/function/interaction test system, a canonical `primary`/`secondary` model policy, complete token-usage visibility, and an Electron diagnostic correlation path.

It does not implement browser capability, web search/fetch, conversation branches, rollback, a branch tree, or durable session todo. It does not authorize a five-day daily-use exercise before the exit criteria below are met. Cost accounting is explicitly deferred; this wave records token, cache, context, call identity, and terminal status only.

The following are planning prerequisites, not completed work:

- ~~The uncommitted Agent workspace cwd fallback must be independently reviewed, tested, and merged through the normal PR path~~ **Done in A0 (PR #40).**
- ~~`PreferencesStore.update()` must be checked and repaired if it drops `subagents` on write; route-to-file-to-reopen regression evidence is required.~~ **Confirmed defective and repaired in A0 (PR #42, RED→GREEN regression).**
- ~~`docs/project-status.md` must remain consistent with the verified commit, tag, and draft-release facts.~~ **Corrected in A0 (PR #41).**

## 2. Verified starting point

The repository already has root Vitest tests, Web component tests and Web Playwright coverage. It has no dedicated Desktop test package, no persistent Desktop Playwright suite, no standard isolated Desktop fixture, and no Desktop CI launch smoke. `DesktopDataSource` already separates Mock and IPC implementations, which is the boundary to test for parity.

The current usage store records successful main-session `turn.completed` usage with `(session_id, turn_id)` idempotency. Subagent run rows retain lifecycle and accumulated tokens but are not in the usage API. `completeText()` utility calls do not return usage metadata. Desktop exposes session usage but lacks the global source/role view.

The current model configuration has global primary-like preferences, `subagents.defaultModel`, memory utility settings, and fallback selection in different paths. The implementation must converge them without silently discarding old data.

## 3. Dependency graph and integration barriers

```text
A0 (baseline and existing defect closeout, serial)
  -> A1 (test asset and harness contract, serial)
      -> A2 (Desktop Mock harness) || A3 (Electron true-chain harness)
      -> A4 (full existing-function regression lanes)
      -> A5 (Electron diagnostic correlation; may start after A1)

A6 (canonical model policy, serial)
  -> A7 (model caller wiring lanes) || A8-schema (usage schema/migration, serial)
                                  -> A8-ingestion/query/Desktop lanes
                                      -> A9 (integration and quality gate, serial)
```

`A0`, `A1`, `A6`, and the usage schema/migration portion of `A8` are serial because they establish shared facts or contracts. A2 and A3 may run in `parallel_group: wave-a-desktop-harness` after A1, because their production file ownership is disjoint. A7 caller lanes may run in `parallel_group: wave-a-model-callers` after A6. Usage ingestion, query, and Desktop presentation may only run in parallel after the migration is frozen and each lane has disjoint files. A4 is split only after the harness contract is stable. The main Agent must re-check parallel eligibility at dispatch time.

## 4. File ownership map

| Task | Planned ownership | Explicitly excluded |
|---|---|---|
| A0 | Existing cwd fallback files, `PreferencesStore` and focused regression tests, status correction | New model/usage implementation |
| A1 | New matrix/spec assets, test conventions, fixture contract | Production behavior |
| A2 | Desktop Mock test config, fixtures, Page Objects, Mock UI tests | Server/runtime contracts and Electron harness |
| A3 | Electron runner, isolated home/user-data-dir fixtures, faux Provider fixture, CI smoke | Production IPC semantics and shared services |
| A4 | New regression specs and evidence manifests per lane | Shared schema/route changes |
| A5 | Electron diagnostic bridge/view tests and diagnostic documentation | Business retry/permission policy |
| A6 | Model policy contract/selector, preference migration and policy tests | Individual model caller wiring |
| A7 | Caller-specific runtime tests and adapters within assigned lanes | Canonical policy and usage migration |
| A8 | Usage schema/migration, recorder/query route, Desktop usage view and tests by sub-lane | Conversation branch and browser features |
| A9 | Integration fixtures, acceptance scripts, plan evidence and status/changelog updates | Unrelated product behavior |

Exact paths must be finalized in each dispatch brief after the current tree is re-read. No task may claim ownership of a shared contract, migration, route registry, or lock file without the main Agent assigning it explicitly.

## 5. Task briefs

### A0 — Baseline and existing defect closeout

- **role:** Establish an auditable starting point before new wave work.
- **read_first:** `AGENTS.md`, `docs/document-governance.md`, `docs/development.md`, `plans/README.md`, `docs/project-status.md`, `plans/p1-hotfix-session-cwd-fallback.md`, current diff, `src/config/preferences-store.ts`, settings route, and focused tests.
- **owns:** The already-uncommitted cwd fallback files and its plan; the minimal PreferencesStore fix and regression tests; the factual status-document correction.
- **forbidden:** No `references/` edits, no destructive Git operations, no release deletion, no new-wave feature implementation, no treating the working tree as `main`.
- **interface:** Preserve cwd precedence: explicit request, Agent default, per-Agent workspace fallback; retain the no-Agent/no-cwd 400 negative path. Preserve and persist `subagents` preferences through settings update and reopen.
- **requirements:** Keep the hotfix independently reviewable. Record the verified commit/tag/release distinction. Use stable Chinese recovery copy where needed.
- **acceptance:** Focused regression reproduces the prior failure before the fix and passes after it; route → file → close/reopen retains `subagents`; root and Desktop type/build checks are independently green; the change is merged by PR before later implementation waves.
- **decision_mode:** `human-fixed` for the cwd fallback and the two-tier goal; `agent-recommends` for local error wording.
- **report:** Append real commit hashes, commands, exit codes, evidence paths, and deviations to this plan’s Implementation Log.
- **docs:** Update `docs/project-status.md`; update `CHANGELOG.md` only if the merged hotfix is user-visible.

### A1 — Test asset matrix and fixture contract

- **role:** Define the complete, durable test inventory and common execution rules.
- **read_first:** This spec, `docs/development.md`, `plans/desktop-e2e-test-plan.md`, `desktop/src/data/source.ts`, Mock/IPC sources, existing CI and package scripts.
- **owns:** Matrix and evidence-manifest files, test naming/ID convention, Desktop selector/Page Object convention, isolation and faux-provider contract documentation.
- **forbidden:** No production feature behavior, no rewrite of historical E2E results, no new dependency without an approved spec amendment.
- **interface:** Every asset row contains module, function, detailed interaction, backend/storage truth, expected visible result, automation layer, evidence path, state and risk. L0-L7 are asset, unit, contract/adapter, server integration, Web, Desktop Mock, Desktop Electron, resilience/release.
- **requirements:** Define temp `OPENCOLORFUL_HOME`, isolated Electron `user-data-dir`, e2e data prefixes, cleanup, screenshot/trace/log retention, API/JSONL/SQLite comparison and Mock/IPC wire-shape parity.
- **acceptance:** All currently implemented modules have at least one detailed interaction chain and a mapped automation layer; known SKIP/FAIL/BLOCKED-ENV cases are explicit; main Agent reviews the matrix for completeness.
- **decision_mode:** `human-fixed` for coverage intent and product frontend boundaries; `agent-recommends` for IDs/selectors and evidence layout.
- **report:** Fixed report structure in this plan, including executed command and exit code for each gate.
- **docs:** Link the matrix from this plan and the new Desktop test documentation; do not duplicate product requirements into `docs/project-status.md`.
- **deliverables (2026-09-01):** [`docs/testing/test-asset-matrix.md`](../docs/testing/test-asset-matrix.md) — all 22 module codes now populated (CHAT~SHELL appended in A1) — and [`docs/testing/desktop-test-conventions.md`](../docs/testing/desktop-test-conventions.md) — L5/L6 engineering, selector, isolation, evidence and Mock/IPC parity contract that A2/A3 must follow.

### A2 — Desktop Mock UI harness (`parallel_group: wave-a-desktop-harness`)

- **role:** Provide fast renderer-level regression for visible states without a backend.
- **read_first:** A1 contract, `desktop/src/data/source.ts`, `mock-source.ts`, all Desktop pages/components, `desktop/package.json`, Vite and existing mock fixtures.
- **owns:** Desktop test entry/config, MockDataSource state fixtures, Page Objects/selectors, renderer component/integration tests and their evidence helpers.
- **forbidden:** No Server/runtime/schema changes; no assumption that Mock success proves IPC success; no production semantic changes to satisfy tests.
- **interface:** Mock implements `DesktopDataSource` and can inject loading, empty, stream, offline, error, retry, persistence and malformed-response states.
- **requirements:** Cover onboarding, Agent/profile, workspace, empty composer first message, settings, memory, logs, Subagent Dock, compact/plan projections, theme and narrow viewport.
- **acceptance:** Real clicks and text entry assert visible results and no console errors; the suite is repeatable from the documented Desktop command and produces trace/screenshot artifacts on failure.
- **decision_mode:** `agent-recommends` for test harness details; `human-fixed` for product IA and visible semantics.
- **report:** Use the fixed report contract and include Mock/IPC parity gaps.
- **docs:** Record the test command and fixture lifecycle in the implementation plan and development/test documentation if a new quality gate is added.

### A3 — Electron true-chain harness (`parallel_group: wave-a-desktop-harness`)

- **role:** Test the real preload → main IPC → Supervisor/Server → SQLite/PI JSONL → Desktop projection path.
- **read_first:** A1 contract, historical Desktop E2E list, `desktop/electron/main.cjs`, preload, `desktop/src/data/ipc-source.ts`, Supervisor startup and release scripts.
- **owns:** Electron Playwright runner, isolated home/user-data-dir lifecycle, faux Provider fixture, launch/cleanup utilities, CI smoke configuration and true-chain Page Objects.
- **forbidden:** Do not use the author’s home or credentials; do not restart shared services from ordinary cases; do not alter production IPC behavior to make tests pass.
- **interface:** Each case gets an isolated `OPENCOLORFUL_HOME` and Electron `--user-data-dir`; API/JSONL/SQLite reads are read-only truth comparisons; only a resilience lane may inject process failures.
- **requirements:** Cover fresh launch, onboarding, Agent creation, missing-cwd session creation, first message, SSE, Abort, reload/restart, archive/rename/compact, Provider/Settings/Usage and disconnect recovery.
- **acceptance:** Stable CI smoke launches and completes a minimal real flow; failures retain screenshot, trace, log and environment metadata; no shared user data remains after teardown.
- **decision_mode:** `agent-delegated` for fixture lifecycle; `human-fixed` for matrix scope and isolation.
- **report:** Record command, exit code, artifacts, environment blockers and truth comparisons.
- **docs:** Add the suite to the plan and CI/release documentation; do not mark the historical checklist retroactively complete.

### A4 — Existing-function full regression lanes

- **role:** Execute the matrix against every currently implemented front-end and back-end feature.
- **read_first:** A1-A3 contracts, all relevant route/service tests, historical E2E evidence and current source for each lane.
- **owns:** New regression specs, lane-specific fixtures and evidence manifests only.
- **forbidden:** No shared contract/schema/route modifications; no silent conversion of a missing feature into PASS.
- **interface:** Lanes are `A4a onboarding/Agent/workspace/session`, `A4b chat/stream/recovery`, `A4c Provider/settings/model`, `A4d Memory`, `A4e Subagent`, and `A4f Plugin/Skill/Supervisor/observability/usage/release`.
- **requirements:** Each lane tests happy path, negative path, persistence/restart where relevant, visible UI state and backend truth. The missing-cwd case is a required regression, not an implicit assumption.
- **acceptance:** Every row has a real result and evidence path; FAILs contain a root cause or a clearly bounded investigation; SKIP and environment blocks state why and what would unblock them.
- **decision_mode:** `human-fixed` for required coverage; `agent-recommends` for lane-local fixture details.
- **report:** One fixed report per lane, reviewed independently by the main Agent.
- **docs:** Update the matrix and this plan’s implementation log; user-visible fixes also update Changelog during implementation.

### A5 — Electron logging and diagnostic correlation

- **role:** Make a user-visible failure traceable across Desktop and runtime layers.
- **read_first:** Electron main/preload/renderer logging, Supervisor diagnostics, Server activity/audit/diagnostic routes, session/subagent lifecycle and existing redaction rules.
- **owns:** Diagnostic correlation bridge/view tests, filtering/inspection affordances and the affected technical documentation.
- **forbidden:** No business retry changes, no permission-policy expansion, no prompt/completion/API key/Authorization/Cookie logging.
- **interface:** Use stable correlation/trace/session/thread/run/call identifiers where available; separate diagnostic, activity and audit channels; redact metadata before persistence or UI display.
- **requirements:** Cover startup failure, IPC timeout, disconnect, Provider error, restart, cancellation and background-run failure. A user-facing error must expose a safe reference that can locate related diagnostics.
- **acceptance:** A real Electron failure can be followed from UI message to IPC and Server/runtime records; records survive the documented retention boundary; sensitive values are absent from stored and displayed payloads.
- **decision_mode:** `agent-recommends` for field naming if no existing contract governs it; `human-fixed` for redaction and channel boundaries.
- **report:** Include one end-to-end correlation example, commands and evidence.
- **docs:** Update observability/diagnostic documentation and the plan; add Changelog entry only for user-visible diagnostics.

### A6 — Canonical primary/secondary policy and migration

- **role:** Freeze the shared model-selection contract before callers are rewired.
- **read_first:** Preferences contracts/store/routes, ProviderStore/ModelService, session runtime, Subagent policy/tools, Memory settings and `completeText`, background review, migrations and tests.
- **owns:** Canonical model-policy contract and selector, preference persistence repair, migration/compatibility logic, conflict diagnostics and contract tests.
- **forbidden:** No caller-specific fallback, no credential persistence changes, no PI SDK boundary changes, no third-tier model.
- **interface:** Callers request `selectPrimary(context)` or `selectSecondary(reason, context)` and receive provider/model, role, source and stable error information. The selector owns precedence and availability checks.
- **requirements:** Primary is the main conversation default; secondary serves all non-main one-shot/background work. Define old-field precedence, per-Agent override compatibility, unavailable-model behavior, restart compatibility and explicit Session override semantics.
- **acceptance:** Fresh and legacy preferences load consistently; `subagents` survives write/reopen; conflicts are diagnosable; no-credential and unavailable-secondary negative cases are stable; policy tests prove callers cannot silently use an old fallback.
- **decision_mode:** `agent-recommends` until accepted through the Feature Spec/PR; after acceptance the policy is `human-fixed` for the wave.
- **report:** Record migration examples, precedence table, test output and unresolved compatibility risks.
- **docs:** Update the Feature Spec, plan, and an ADR/architecture note only if the policy becomes a long-lived architectural invariant.

### A7 — Wire model policy into callers (`parallel_group: wave-a-model-callers`)

- **role:** Remove independent model selection from all runtime callers after A6.
- **read_first:** A6 contract, assigned caller source/tests, Session runtime, Subagent thread/run creation, MemoryTicker/Agent/summary/review/compaction utility paths.
- **owns:** One assigned caller lane at a time: A7a Session, A7b Subagent, A7c Memory/summary/background/compaction, A7d Desktop settings and Mock/IPC source parity.
- **forbidden:** No policy contract or migration edits; no new routing tier; no caller-specific silent fallback.
- **interface:** Each caller passes an explicit primary/secondary intent and stable reason/context to A6; errors are safe and actionable for the caller’s surface.
- **requirements:** Existing Session explicit model changes remain explicit; all non-main work uses secondary; per-Agent settings do not bypass canonical semantics; tests cover success, unavailable model, cancellation and restart.
- **acceptance:** Source review and tests show every assigned path uses A6; main Agent performs a repository search for bypasses before integration.
- **decision_mode:** `human-fixed` for the two-tier semantics; `agent-recommends` for caller-local error presentation.
- **report:** Fixed report with paths searched, commands, output and bypass audit.
- **docs:** Update the Feature Spec/plan if a compatibility exception is discovered; do not create a second policy document.

### A8 — Unified usage schema, ingestion, query and Desktop view

- **role:** Make all model usage observable without replacing lifecycle stores.
- **read_first:** Current usage store/routes/recorder, `subagent_runs`, `completeText`, event mapper, migrations, Desktop source/views, A6 policy.
- **owns:** First serial schema/migration contract; then disjoint ingestion, query API, Desktop UI and test files assigned by the main Agent.
- **forbidden:** No cost guessing, no prompt/completion persistence, no deletion of `subagent_runs`, no schema edits in parallel lanes before migration freeze.
- **interface:** Unified records carry source, role, Provider/model, Agent/Session/Thread/Run/Call/correlation IDs, token/cache/context fields, timestamps, status and an idempotency key. `subagent_runs` remains lifecycle/budget truth.
- **requirements:** Record available partial usage for failed/cancelled/timeout/interrupted/budget-exhausted calls; utility adapters return structured metadata or explicit null/zero semantics; expose global and Session summaries with source/role filters.
- **acceptance:** Main, Subagent and utility samples are queryable; duplicate events do not double count; migration and reopen preserve data; Desktop has global usage, filters and empty/loading/error states; sensitive bodies are absent.
- **decision_mode:** `agent-recommends` for column naming within the documented information set; `human-fixed` for no-cost/no-sensitive-body constraints.
- **report:** Include schema version, migration result, sample query output and UI evidence.
- **docs:** Update usage/architecture documentation, Feature Spec and Changelog only for user-visible usage UI.

### A9 — Wave integration and quality gate

- **role:** Independently verify that the wave is a coherent, repeatable deliverable.
- **read_first:** All A0-A8 reports, matrix, CI configuration, `docs/development.md`, release/test documentation and current status.
- **owns:** Integration runners, evidence index, implementation log and the status/changelog updates required by the impact matrix.
- **forbidden:** No new feature scope during integration; no hiding FAIL/SKIP/BLOCKED-ENV under aggregate counts.
- **interface:** Every gate is run as a separate command with captured exit code; long jobs write result files and are polled rather than chained.
- **requirements:** Run, separately:
  `node scripts/verify-pi-sdk-imports.mjs`; `npx tsc --noEmit -p tsconfig.json`; `npx vitest run`; `npm run test --workspace=web`; `npm run web:build`; `npx tsc -p tsconfig.build.json`; `npm run desktop:build`; `cd web; npx playwright test`; Desktop Mock suite; Electron true-chain suite; migration/restart/resilience/install smoke.
- **acceptance:** Matrix complete; Mock and true-chain suites repeat; policy is unified; usage is queryable across sources/roles; one real failure is correlated; all deviations are recorded. Only then may P1 proceed to Wave B implementation and later five-day-use consideration.
- **decision_mode:** `human-fixed` for exit conditions; `agent-recommends` for evidence presentation.
- **report:** Main Agent writes the final evidence index and does not accept child reports as standalone proof.
- **docs:** Update `docs/project-status.md`, the Feature Spec and Changelog only for user-visible changes; leave status as Planning until all evidence exists.

## 6. Quality gates and evidence rules

All commands are independent and must include exit codes. Default tests use isolated homes and PI faux providers. Desktop acceptance must include real user actions, screenshots/traces and API/JSONL/SQLite truth comparisons. A child-agent report is a work report, not acceptance evidence; the main Agent must inspect the diff and rerun the relevant commands.

## 7. Implementation log template

Each completed task appends:

```text
Date:
Task:
Commit(s):
Commands and exit codes:
Evidence paths:
Observed result:
Unverified:
Deviation and follow-up:
Main-Agent review:
```

The plan remains `Planning` until the real implementation and interaction evidence satisfy the exit conditions. Creating this plan does not mean any task is implemented.

## 7.1 Implementation log

### 2026-09-04 review-repair execution briefs

`parallel_group: review-repair-2026-09-04`. The production fixes are already isolated by
review finding; the lanes below share no writable files or contracts. The integration barrier is
main-Agent diff review followed by the repository quality gates. Initial Luna dispatches with
`reasoning_effort=max` were rejected by the runtime because `gpt-5.6-luna` supports up to
`xhigh`; retries therefore pin `model=gpt-5.6-luna`, `reasoning_effort=xhigh`, and
`fork_turns=none` rather than inheriting the main model.

**Lane RR-A7 (read-only caller audit):** role = verify the A7 primary/secondary caller wiring and
identify missing tests or bypasses; read_first = `AGENTS.md`, `docs/development.md`, A6/A7 sections
of this plan, `src/runtime/model-policy.ts`, `src/server/routes/sessions.ts`, `src/server/start.ts`,
`desktop/src/App.tsx`, and their tests; owns = no files (read-only); forbidden = edits, commits,
dependency changes, and `references/`; interface = A6 selectors are the sole automatic selection
authority and environment/first-credentialed enumeration is forbidden; requirements = search all
production callers, inspect per-Agent memory behavior and Desktop draft initialization, and propose
the smallest missing coverage; acceptance = report exact paths/lines, bypass search terms, and
commands; decision_mode = `human-fixed`; report = development.md section 5 structure; docs = none.

**Lane RR-EXIT (exit-code regression):** role = cover the PR #49 Node exit-code compatibility fix;
read_first = `AGENTS.md`, `docs/development.md`, `src/sandbox/local-backend.ts`, and existing sandbox
tests; owns = `tests/unit/local-backend.test.ts` only (create if appropriate); forbidden = production
edits, other tests, lockfiles, commits, and `references/`; interface = integer and integer-string
exit codes are preserved, signal/non-numeric values normalize to `1`; requirements = test public
`LocalBackend.execute()` behavior without weakening path/sandbox checks; acceptance = focused Vitest
pass with real output; decision_mode = `agent-delegated`; report = development.md section 5 structure;
docs = none.

**Lane RR-DESKTOP (draft-model regression):** role = cover the A7 Desktop removal of silent
first-credentialed fallback; read_first = `AGENTS.md`, `docs/development.md`, `desktop/src/App.tsx`,
`desktop/src/chat.mock.test.tsx`, Desktop fixtures/source contracts, and A6/A7 plan sections; owns =
`desktop/src/chat.mock.test.tsx` only; forbidden = production edits, other tests, lockfiles, commits,
and `references/`; interface = a valid saved default initializes the draft, while missing/unavailable
preference leaves it unselected even when another credentialed model exists; requirements = use
existing Mock/UI conventions and visible behavior; acceptance = focused Desktop Vitest pass;
decision_mode = `human-fixed`; report = development.md section 5 structure; docs = none.

**Lane RR-SUBAGENT (canonical secondary wiring):** role = remove the production Subagent
`parent_inherited` fallback and route spawn model selection through A6 `selectSecondary`; read_first =
`AGENTS.md`, `docs/development.md`, A6/A7 in this plan, `src/runtime/model-policy.ts`,
`src/pi-sdk/subagent-tools.ts`, `src/pi-sdk/subagent-tools-context.ts`,
`src/runtime/subagents/composition.ts`, and Subagent core/security/repro tests; owns = those three
production files plus `tests/unit/subagents-core-tools.test.ts`,
`tests/unit/subagents-security-regression.test.ts`, and
`tests/integration/subagent-spawn-repro.test.ts`; forbidden = policy contract changes, DB migrations,
other tests, lockfiles, commits, and `references/`; interface = explicit spawn model >
`subagents.defaultModel` > legacy memory utility mapping, never parent primary inheritance; historical
`parent_inherited` rows remain readable; requirements = preserve stable Subagent error codes and map
A6 failures without raw Provider errors; acceptance = focused Subagent suites pass and a regression
proves primary-only configuration cannot create a Subagent thread; decision_mode = `human-fixed`;
report = development.md section 5 structure; docs = none.

**Lane RR-MESSAGES (production no-model fail-closed):** role = prevent the production messages
route from silently constructing a faux runtime when a Session has no selected model; read_first =
`AGENTS.md`, `docs/development.md`, A6/A7 in this plan, `src/server/routes/messages.ts`, Server app
fixtures, and message/session integration tests; owns = `src/server/routes/messages.ts` and new
`tests/integration/message-model-policy.test.ts`; forbidden = shared contracts, Session route edits,
existing modified tests, lockfiles, commits, and `references/`; interface = faux remains available
only for explicitly test-injected/no-production-model-service paths, while a production
`modelService` plus `session.model=null` returns a stable actionable 409 before Runtime creation;
requirements = do not expose Provider internals and prove PromptService receives no runtime/run;
acceptance = focused new test passes plus relevant message integration tests; decision_mode =
`human-fixed`; report = development.md section 5 structure; docs = none.

`serial_reason`: the main Agent keeps `src/server/start.ts`, Session route integration, event-terminal
integration, plan writeback, package-lock normalization, and full quality gates serial because they
touch shared composition-root/runtime state or aggregate evidence across all lanes.

### 2026-09-04 review-repair closeout

Implementation (main Agent integration after independent Luna lane reports):

- PR #51 terminal uniqueness: `PlatformEventMapper` now accepts one terminal per PI turn,
  suppresses `turn.completed` after assistant `error`/`aborted`, and `SessionRuntime` closes
  instrumentation exactly once; failed/aborted usage is not recorded as successful usage.
- PR #52 diagnostic correlation: a non-empty main-process `diagRef` wins over the session-path
  fallback, preserving shell-log-searchable references for network/502/server failures.
- PR #49 exit-code compatibility: `LocalBackend` normalizes Node 26 signal/non-numeric exit codes
  to `1` while preserving integer and integer-string codes; focused coverage is 13 tests.
- A7 caller wiring: Session creation uses `selectPrimary`; memory/summary/background/compaction
  utilities use `selectSecondary`; Subagent spawn uses the same selector and no longer inherits the
  parent primary model; Desktop quick and advanced new-session flows never choose the first
  credentialed model and require explicit selection.
- Production fail-closed: messages route refuses to create a faux runtime when a real
  `modelService` is present but the Session has no selected primary model. Dedicated regression
  coverage asserts HTTP 409 and no Runtime creation.
- Real E2E fixtures now explicitly persist `subagents.defaultModel` after configuring their fixture
  Provider, matching the frozen A6 contract.

Independent verification (all commands run separately by the main Agent):

- `npm run check:docs` → exit 0; `node scripts/verify-pi-sdk-imports.mjs` → exit 0;
  `npm run check:plugin-imports` → exit 0.
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- `npx vitest run` → 183 files / 2193 tests passed in the final full run; the sole failure was
  `tests/integration/supervisor.test.ts` Agent Server health wait under concurrent Windows load.
  The failing case passed independently with `--testTimeout=60000`; no business assertion failed.
- Focused review suites → 8 files / 89 tests passed.
- `npm run test --workspace=@opencolorful/desktop` → 12 files / 58 tests passed.
- `npm run test --workspace=web` → 34 files / 426 tests passed (happy-dom iframe connection noise
  remains expected and does not affect exit code).
- `npm run build:protocol`, `npm run build:sdk`, `npm run build`, `npm run web:build`, and
  `npm run desktop:build` → all exit 0.
- `cd web; npx playwright test` → 59 tests passed; the two initial failures were fixed by explicit
  secondary-model fixture setup, then the complete suite passed.

Known non-blocking environment note: Supervisor and PATH-scan tests can exceed the default global
Vitest timeout under concurrent Windows load; isolated reruns passed (`supervisor-watchdog` 6/6,
`detect-path-bins` 5/5, `server-restart` 1/1 with a 60s test timeout, and the failing Supervisor
logs case 1/1 with a 60s test timeout). No business assertion remains failing in final targeted runs.

```text
Date: 2026-08-31
Task: A0 — Baseline and existing defect closeout
Commit(s): fa20153 (PR #40, cwd fallback hotfix), 2efe828 (PR #41, planning docs + status facts), 084414c (PR #42, PreferencesStore subagents persistence)
Commands and exit codes:
  - npx vitest run tests/integration/session-agent-binding.test.ts → 11/11 pass
  - npx vitest run tests/unit/preferences.test.ts tests/integration/settings-routes.test.ts → 29/29 pass
  - RED proof: with the preferences-store fix stashed, the 3 new regression tests fail; restored, all pass
  - npx tsc --noEmit -p tsconfig.json → 0; desktop npx tsc -p tsconfig.json --noEmit → 0
  - npm run check (full chain, /tmp/oc-check2.log) → 2129 root tests + 426 web tests + desktop build all pass
  - PR CI: #40 / #41 / #42 each Governance + Typecheck,tests and builds + Browser E2E all pass
Evidence paths: plans/p1-hotfix-session-cwd-fallback.md; CHANGELOG.md Unreleased (two Fixed entries); PR #40/#41/#42 descriptions
Observed result: cwd fallback merged (explicit > agent default > per-agent workspace); POST /api/sessions without agentId/cwd still 400; draft-state chat errors render; subagents.defaultModel persists through route → file → reopen and survives unrelated preference writes; docs/project-status.md baseline and G2 draft-release facts corrected
Unverified: real installed-app (Electron packaged) exercise of the cwd fallback — covered by Wave A A3 true-chain harness, not re-verified manually here
Deviation and follow-up: PR #42 required a branch update after #41 merged (squash sequencing); no code conflicts. A1+ not started
Main-Agent review: diffs reviewed directly; RED→GREEN reproduced locally; child reports not used as evidence
```

```text
Date: 2026-09-01
Task: A1 — Test asset matrix and fixture contract
Commit(s): this change on branch p1-wave-a-a1-test-assets (final hash recorded at PR squash merge)
Commands and exit codes:
  - npm run check:docs → exit 0 (document governance over the new docs/testing assets and status edits)
  - Full npm run check not rerun: docs-only change, no production code touched; baseline main b244fa1 was CI-green on PR #43
Evidence paths: docs/testing/test-asset-matrix.md (CHAT/SSE/ABORT/COMPACT/PROV/SET/MEM/TICK/MAGENT/SUB/PLUG/SKILL/SUPV/OBS/USAGE/SEC/REL/SHELL appended — 18 module codes); docs/testing/desktop-test-conventions.md (new L5/L6 contract)
Observed result: matrix covers all 22 module codes; every row carries interaction chain, server facts, automation layer, existing coverage and explicit status; Desktop-only layers stay SKIP with 未建 reasons; L5/L6 engineering, selector, isolation, evidence and parity rules fixed in the conventions doc
Unverified: rows whose target layer is L5/L6/L7 remain SKIP by definition until A2/A3/A9 execute them; Plugin/Skill rows record the "no Desktop UI entry" fact rather than promising coverage
Deviation and follow-up: matrix and conventions doc written in Chinese to match the existing draft and the author's reading flow; per document-governance §8 渐进迁移 no English companion was created (this plan stays the A-class English authority). A2/A3 dispatch must list desktop-test-conventions.md in read_first. Main Agent directly authored this docs-only task (allowed by development.md §一 "仅 infra/文档/救火")
Main-Agent review: rows cross-checked against src/server/app.ts route registry, desktop/src/data/source.ts contract, electron IPC channels (desktop:api, desktop:pick-directory, update:*), desktop/package.json (no test infra yet) and the root/web test file inventory; no child agents involved
```

```text
Date: 2026-09-01
Task: A2 — Desktop Mock UI harness (parallel_group: wave-a-desktop-harness)
Commit(s): 7a5330c (A2 lane), e5601ff (shared test deps by main agent, pre-commit to keep lanes disjoint)
Commands and exit codes:
  - npm run test --workspace=@opencolorful/desktop → 11 files / 24 tests passed, exit 0 (rerun for repeatability, exit 0)
  - npx tsc -p tsconfig.json --noEmit (desktop) → exit 0
  - Main agent independently re-ran both commands after the A2 report; identical results
Evidence paths: desktop/vitest.config.ts; desktop/src/test/setup.ts; desktop/tests/fixtures/** (9 Page Objects, override-source, SSE replay); desktop/src/*.mock.test.tsx (11 files)
Observed result: 24 cases mapped to 18 L5 matrix rows; real clicks/typing with role+name locators, per-case no-console-error assertions; parity gaps recorded rather than papered over
Unverified: rows whose target layer includes L6/L7; rows the matrix marks "Mock 不支持" (断线语义、多助理隔离等) not faked
Deviation and follow-up (Mock/IPC parity gaps, from child report + main-agent confirmation):
  1. MockDataSource.getMemoryData ignores agentId/query (tsc-proven); MEM-02 q-filter simulated in fixture
  2. Mock createThread drops CreateThreadOptions (cwd/toolMode/thinkingLevel/workspaceConfirmed) — those semantics only L6
  3. subscribeMemoryMaintenance/subscribeActivityStream are no-ops; subagent source ignores agentId/sessionId
  4. Machine shell carries NODE_ENV=production → vitest config pins NODE_ENV=test
  5. data-testid 缺口清单（oc-composer-send 等 8 项）记录于报告，待后续补齐后收敛定位策略
Main-Agent review: diff reviewed directly; gates re-run independently; child report used as work record only
```

```text
Date: 2026-09-01
Task: A3 — Electron true-chain harness + CI smoke (parallel_group: wave-a-desktop-harness)
Commit(s): a39cf2a (A3 lane), b99d8da (production hotfix uncovered by this lane, main agent)
Commands and exit codes:
  - npx playwright test --config desktop/tests/e2e/playwright.config.ts --grep @smoke → 1 passed (23.2s), exit 0; repeat run also passed
  - npx tsc -p tsconfig.json --noEmit (desktop) → exit 0
  - npx vitest run tests/unit/desktop-projector.test.ts → 14/14 passed (3 new terminal-state cases)
  - npm run check full chain → executed 2026-09-01 in two passes; first pass caught two machine-environment issues, second pass green on every gate (details below)
Environment repairs made during the gate run (main agent, both test-infra only):
  1. better-sqlite3 had been rebuilt for Electron's ABI (137) by the A3 debugging session → root vitest (2135 tests) all failed with NODE_MODULE_VERSION mismatch; `npm rebuild better-sqlite3` restored Node 22 ABI (127); the desktop pack chain re-rebuilds for Electron at pack time (G2 T3b ordering), so root ABI is the correct resting state
  2. Author's shell carries NODE_ENV=production → React 19 production build has no `act` → web vitest (134 cases) failed; fixed by pinning NODE_ENV=test in web/vitest.config.ts (same fix A2 applied to desktop/vitest.config.ts)
Gate evidence (all separate commands, exit codes read):
  - check:docs / check:pi-imports / check:plugin-imports / build:protocol / build:sdk / typecheck → exit 0
  - npx vitest run (root) → 180 files / 2135 tests passed
  - npm run web:test → 34 files / 426 tests passed (after NODE_ENV pin)
  - npm run web:build → exit 0; npm run desktop:build → exit 0
Evidence paths: desktop/tests/e2e/** (config, harness/backend/app/server-bootstrap fixtures, 2 Page Objects, @smoke spec); .github/workflows/quality.yml (desktop-smoke job); docs/ci-cd.md; artifacts at desktop/test-artifacts/ (gitignored)
Observed result: true-chain flow passes on Windows — onboarding → no-cwd session (cwd fallback anchor) → first message streaming → abort → second message → restart persistence; truth assertions over API/JSONL/providers.json/auth.json; credential red lines (key only in AuthStorage); isolation self-checks
Fixture defects found and fixed during bring-up (child agent hit turn limit mid-debug; main agent took over per development.md §一):
  1. REPO_ROOT resolved one level short → require(electron) looked in desktop/node_modules
  2. fs.cpSync native crash (0xC0000409) during retain evidence copy on Windows → replaced with manual copy; had masked the real failure
  3. stub Provider treated request-body consumption as client abort (request 'close') → abort detection moved to response 'close' with finished flag
Isolation defect (user-visible impact): PI built-in catalog counts DEEPSEEK_API_KEY etc. as configured (source=environment, references/pi model-runtime.ts:424-425); the author's real (expired) key reached the real DeepSeek API during tests → fixtures now strip credential env vars for both the bootstrap and the Electron app
Product defects uncovered and hotfixed in b99d8da (details in that commit + CHANGELOG):
  1. completeOnboarding did not refresh models/preferences — on clean machines the first message is blocked by "还没有可用模型"; on machines with provider env credentials the draft model silently resolved to the built-in deepseek model (real external call)
  2. Desktop projector lacked turn.cancelled/turn.interrupted/turn.failed cases — abort and model failures left the UI stuck streaming forever
Deviation and follow-up:
  - CI desktop-smoke job added but not yet exercised on GitHub runners (xvfb/electron deps to be confirmed on first CI run)
  - Session default model can still fall through to environment-credential built-ins server-side when preferences carry no model — canonical primary/secondary policy (A6) is the structural fix; smoke now pins defaults.model via API to stay deterministic
  - Failed turn renders an empty assistant bubble with "生成失败" meta (cosmetic; noted for A7 polish)
Main-Agent review: diff reviewed directly; smoke re-run independently; child report used as work record only
```

```text
Date: 2026-09-02
Task: A4 wave 1 — existing-function regression lanes A4a/A4b/A4c (parallel_group: wave-a-a4-lanes)
Branch: p1-wave-a-a4-regression (stacked on p1-wave-a-desktop-harness for A1-A3 contracts)
Commits: 8624f8b (production hotfixes uncovered by the lanes, main agent), 528f113 (A4a), 9d2e310 (A4b), bd45ab9 (A4c)
Dispatch: three parallel child agents with disjoint file ownership (lane specs + lane-local fixtures only; shared fixtures/POs/configs read-only). All three hit their turn limit mid-debug without a final report; the main agent took over per development.md §一 and finished/verified each lane.
Cross-lane interference observed (recorded for wave 2): parallel Playwright runs share desktop/test-artifacts/pw-output and clear each other's artifacts → wave-2 lanes must run sequentially or use per-lane output dirs; in-flight edits of one lane can transiently fail another lane's whole-suite run.
Production hotfixes uncovered by the lanes (8624f8b, CHANGELOG updated):
  1. Model-call failures were swallowed: PI returns errors as assistant stopReason="error" without throwing; session-runtime only inspected the throw path → failed turns recorded as turn.completed, no UI terminal. Fix: pi-sdk passes stopReason/errorMessage on message_end, PlatformEventMapper records + exposes lastAssistantError and gains terminal(), runPrompt emits turn.failed (abort path: turn.cancelled) envelopes; contracts/events.ts registers the three terminal types + turn.failed payload (EventSequenceGuard drops unregistered types; negative contract test guards the payload union).
  2. Onboarding "custom" preset kept the previous preset's modelName state → custom models registered as "DeepSeek Chat" (applyPreset now resets modelName for custom).
  3. Memory settings PUT is a whole-object replace; GET+merge+PUT raced on rapid consecutive saves (serialized per-agent write queue in ipc-source).
  4. Dev About page showed the Electron runtime version (main.cjs pins app.setVersion to desktop/package.json when unpackaged).
Test-authoring defects fixed by the main agent (not product issues): wrong profile-page/id-card heading anchors (real DOM: heading 助理档案 + paragraph), archived-row is not a button role, stub setStub only patches (fast mode must re-supply text), fire-and-forget saves need expect.poll on server truth, restart-mid-turn timeline needs a draft→switch detail rebuild (same family as known limitation #7), strict-mode duplicate 已连接 label scoped to the settings dialog, "{Escape}" invalid key name.
Commands and exit codes (all run separately by the main agent):
  - npx playwright test --config desktop/tests/e2e/playwright.config.ts --grep @a4a → 11 passed (1.4m), exit 0
  - --grep @a4b → 5 passed (3.1m), exit 0
  - --grep @a4c → 4 passed (23.5s), exit 0
  - npm run test --workspace=@opencolorful/desktop → 11 files / 42 tests passed, exit 0
  - npx tsc -p tsconfig.json --noEmit (desktop + root) → exit 0
  - npm run desktop:build → exit 0 (required after renderer/main-process changes: e2e loads desktop/dist)
  - tests/contract/events.test.ts + abort/prompt-events/event-mapper/desktop-projector targeted runs → pass (25-39 cases)
  - Full npm run check re-run after writeback commit (see final gate evidence in this log)
Evidence paths: desktop/tests/e2e/lane-a4a-*{onboarding,agent,session,workspace}*, lane-a4b-{chat,abort}*, lane-a4c-provider-settings*; lane fixtures under desktop/tests/e2e/fixtures/lane-a4{a,b,c}/ and desktop/tests/fixtures/lane-a4a/
Observed result: 20 new L6 true-chain cases across 7 specs; matrix rows ONB-05, AGENT-03..06, WS-02/03, SESS-03/04/05, CHAT-05/06, ABORT-01/02, PROV-01..04, SET-05 updated to PASS with dates
Known deviations recorded: 档案页改名不触发 agents 列表刷新（A7 打磨）；在途 turn 完成不自动刷新已打开时间线（已知限制 #7 同族）；草稿模型解析兜底到内置目录（A6 收口）；CI desktop-smoke job 仍待首次 GitHub runner 实测
Main-Agent review: all lane diffs reviewed directly; every lane suite re-run independently by the main agent after fixes; child reports (incomplete) used as work records only
```

```text
Date: 2026-09-02
Task: A4 wave 2 — regression lanes A4d/A4e/A4f (serial dispatch per wave-1 lesson)
Branch: p1-wave-a-a4-regression
Commits: daa24d2 (A4d), 09f5001 (A4e), 2406b22 (A4f)
Dispatch: three lanes dispatched SEQUENTIALLY (one child at a time) per the wave-1 cross-lane interference record. Briefs pre-verified all UI anchors, interface methods and route facts before dispatch.
Child outcomes:
  - A4d Memory: DONE (44 tool uses) — brief-compliant, no boundary violations; report flagged a duplicate MEM-02 coverage question (adjudicated: keep both, extend-not-rewrite).
  - A4e Subagent: hit turn limit (95 turns) after fixtures/PO/spec were written but before any test run; rescued by main agent per development.md §一. Only fix needed: ownerAgentId ownership resolution (spec left it empty → HTTP 400 from routes/subagents.ts §22.1; resolved from session detail agentId). Passed first try after the fix.
  - A4f OBS/USAGE/SEC: DONE (30 turns) — clean report; mock-source untouched (injection via overrideSource instead; approved as the minimal-change reading of the brief).
Verification (all re-run independently by main agent):
  - A4d: desktop vitest 44/44; desktop:build pass; @a4d 1/1 ×3 reruns (4.7-5.0s)
  - A4e: @a4e 1/1 (9.9s)
  - A4f: desktop vitest 50/50 (44→50)
  - Full @a4 sweep: 22/22 across all five lanes in one sequential run (4.5m)
  - Flakiness note: one full desktop-vitest run showed 7 transient waitFor timeouts under heavy parallel load (including wave-1 tests); single-file and full reruns green twice — pre-existing load sensitivity, not introduced by wave 2 (recorded for A7 hardening)
New coverage: MEM-02 mock parity fix (production mock honors q), MEM-05 L6 (deep-dive SSE maintenance bar + report truth), MAGENT-01 L5+L6, SUB-02 L6 (real spawn via stub streaming tool_calls — first lane to drive the real tool-call loop), OBS-02 L5 (filters/pagination/live-follow), USAGE-01 L5 (badge + refresh chain), SEC-04 L5 (approval state machine anchors)
Matrix rows updated: MEM-02/04/05/06, MAGENT-01/02, SUB-02, OBS-02, USAGE-01, SEC-04
Conclusion records (no automatable gap): PLUG/SKILL rows PASS at L1/L3/L4 (no Desktop UI by product design); SUPV-01/02 PASS L3; SUPV-03 pending CI first run; REL-01..04 G2/A3/A9 scope; TICK-02 pending A6
Known deviations recorded: MEM-04 has no Desktop flush UI (立即整理=deep-dive); SEC-04 tests pin the current local-state semantics pending A2 protocol alignment; OBS-02 pagination verified via injected source (production mock ignores cursor)
Main-Agent review: diffs of all three lanes reviewed; A4e rescue fix applied by main agent; all suites re-run independently
```

```text
Date: 2026-09-02
Task: A5 — Electron logging and diagnostic correlation
Branch: p1-wave-a-a5-diagnostics (stacked on p1-wave-a-a4-regression)
Child dispatch: 1 child agent, hit turn limit (100 turns) after completing the implementation and L5 tests, during final verification (load-flake triage); rescued by main agent — verified flakes transient (single-file reruns green), wrote the L6 end-to-end correlation spec, fixed one test-authoring defect (locator role: type=search → searchbox), completed CHANGELOG/matrix closure.
Implementation (all within brief owns):
  - errors.ts: ErrorCorrelation {traceId, origin: "server"|"local", at} + short-ref formatter + local fallback + CorrelatedError passthrough (message classification unchanged)
  - electron/main.cjs: per-failed-API diagRef issuance (`ipc-` + 8 hex, health probe excluded from noise), synced to shell.log; embedded-server startup failure dialog now shows the ref
  - data/ipc-source.ts: failure points throw CorrelatedError — an explicit main-process diagRef (including session-scoped network/502/server failures) wins because it is shell.log-searchable; only without diagRef do session paths reuse the server-stamped sessionId traceId (origin=server), while other failures use a renderer-local id (origin=local); bridge break falls back to local
  - ChatView.tsx: error status rows (运行错误/发送失败) resolve correlation once per error row from queryActivity({sessionId, status:"failed"}) — latest failed record's per-turn traceId, falling back to the session id; rows show 诊断引用 + 在日志中查看
  - App.tsx: error→logs navigation carrying the reference (logsFocus)
  - LogsPage.tsx: traceId filter input (300ms debounce, client matchesFilter + server query param), prefill focus banner, source.ts ActivityFilter.traceId
  - Tests: L5 in chat.mock/observability.mock (error-row reference render, navigation prefill, local-origin degradation, redaction assertions); L6 lane-a5-diagnostics.truechain.spec.ts (@a5) — stub error-401 → turn.failed row → reference → 在日志中查看 → logs prefilled → server activity?traceId=<ref> hits the failed record; fake key absence asserted at UI and server layers
Redaction/channel boundaries (human-fixed): references contain id + timestamp only; no prompt/completion/key values in any persisted or displayed path (asserted in tests); diagnostic (shell.log/tail), activity, audit channels not mixed
End-to-end correlation example (from @a5 run): UI error row 诊断引用 tr-608b3ef3 → full traceId 608b3ef34caf8d7f → GET /api/observability/activity?traceId=608b3ef34caf8d7f → turn.failed/failed record (turn, agent-server, 27ms)
Verification (main agent, independent):
  - desktop vitest 54/54 (50→54); desktop:build pass; @a5 1/1 (8.0s)
  - Two transient load flakes during child verification (memory MAGENT-01, others) confirmed non-reproducible single-file
  - CHANGELOG Added entry; matrix OBS-05 → PASS（L3/L6，2026-09-02）
Commands: npm run test --workspace=@opencolorful/desktop; npm run desktop:build; npx playwright test --config desktop/tests/e2e/playwright.config.ts --grep @a5
Main-Agent review: full diff reviewed; L6 spec authored and verified by main agent; child's last-mile verification completed by main agent
```

```text
Date: 2026-09-03
Task: A5 review follow-up — preserve IPC diagnostic references on session-path failures
Finding: correlationForPath() unconditionally selected /api/sessions/:id/... sessionId, which could hide the main-process diagRef for network/502/server failures and point the Logs page at a trace with no matching activity.
Fix: correlationForPath() now prefers a non-empty diagRef; it falls back to sessionId (origin=server) only when no diagRef is available, and otherwise generates a renderer-local UUID. The server-trace lookup performed by ChatView remains unchanged and still wins when a concrete failed activity trace is found.
Coverage: desktop/src/data/ipc-source.test.ts covers session-path diagRef precedence, sessionId fallback without diagRef, and non-session diagRef/local UUID fallbacks; targeted file run passed 3/3 and desktop build passed.
```

```text
Date: 2026-09-02
Task: A6 — canonical primary/secondary model policy and migration (contract freeze)
Branch: p1-wave-a-a6-model-policy (stacked on p1-wave-a-a5-diagnostics)
Child outcome: DONE_WITH_CONCERNS (51 turns) — complete implementation; concerns adjudicated by main agent (check:docs pending plan writeback = expected owns boundary; legacy normalize segment-drop is pre-existing store behavior, recorded for A7 adjudication; environment-credential built-ins remain resolvable as EXPLICIT user config — the contract only forbids selector-side enumeration/fallback).
New assets:
  - src/contracts/model-policy.ts: selection/result/source/conflict contract types + ModelAvailabilityPort (structural port: listModels unreachable at type level — environment catalog structurally unselectable)
  - src/runtime/model-policy.ts: selectPrimary/selectSecondary/diagnoseModelConflicts + ModelPolicyError (stable codes: model_not_configured / model_no_credentials / model_unavailable / model_conflict_adjudicated; UNAUTHORIZED/NOT_FOUND normalized, raw PI messages never surfaced)
  - Precedence (frozen, Feature Spec §2.1): primary = explicit(request) > explicit(session) > defaults.model; secondary = explicit(request) > explicit(session) > subagents.defaultModel > memory.utility* legacy mapping (per-Agent memory segment overrides global, consistent with resolveMemorySettings; shadowed/incomplete entries diagnosable)
  - Hard guarantees: no environment/first_credentialed source (constructively asserted in tests); no silent fallback on any tier; conflicts adjudicated by field priority and attached to results/errors; pure functions with injected deps — A7 rewires call sites directly
  - Tests: tests/unit/model-policy.test.ts (29) + tests/integration/model-policy-compat.test.ts (7, real PreferencesStore + ModelService, isolated OPENCOLORFUL_HOME) — precedence table, conflict adjudication, fresh/legacy consistency, no-credential and unavailable-secondary negatives stable, subagents write/reopen preserved
Migration example: legacy preferences with only memory.utility* → selectSecondary source=legacy_memory_utility; conflicting subagents.defaultModel wins by precedence, ghost → model_unavailable with conflict record (no silent borrow of the old field)
Verification (main agent, independent): new contract suites 36/36; child ran root suite 3× (2 full green passes; 1 transient detect-path-bins cleanup timeout under disk load, unrelated, single-file 5/5)
Unresolved compatibility risks (recorded for A7): ① sessions.ts silent-skip on default application; ② start.ts completeText double fallback; ③ desktop App.tsx first-credentialed draft fallback; ④ store-level normalize drops invalid legacy segments (selector then stably reports model_not_configured); ⑤ listModels environment branch — A7 keeps explicit-user-config vs selector-enumeration distinction
Commands: npx vitest run tests/unit/model-policy.test.ts tests/integration/model-policy-compat.test.ts; npm run test; npm run check:pi-imports
Main-Agent review: boundary confirmed (5 files), selector implementation read, contract suites re-run independently; plan writeback + TICK-02 note by main agent (closes check:docs)
```

```text
Date: 2026-09-04
Task: A6/A7 rebase integrity follow-up
Finding: Rebase of the stacked A6/A7 branch accidentally dropped the four A6 implementation/test files
  (the files were present in source commit 79be140 but absent from HEAD a22bdb6), while A7 callers still
  imported them. This made the branch appear clean but fail typecheck with missing-module errors.
Fix: Restored the four files byte-for-byte from 79be140 and staged them for the repair commit:
  src/contracts/model-policy.ts, src/runtime/model-policy.ts,
  tests/unit/model-policy.test.ts, tests/integration/model-policy-compat.test.ts.
Verification: targeted A6 contract/compat suites 36/36 passed; npx tsc --noEmit -p tsconfig.json passed.
Full npm run check is rerun after this governance record is included.
```

```text
Date: 2026-09-04
Task: A6 onboarding true-chain follow-up
Finding: After A6 removed the Desktop first-credentialed fallback, the onboarding flow still only
  persisted the Provider. A fresh Electron run therefore reached the chat draft with model=null and
  blocked the first message with "请先选择模型"; the @smoke test failed before streaming.
Fix: Onboarding now persists the explicitly configured Provider/model as preferences.defaults.model.
  The true-chain smoke no longer mutates preferences behind the UI; it reads and asserts the persisted
  primary default instead. Added a Mock regression assertion for the same contract.
Verification: rerun desktop Mock and Electron @smoke after this fix; results are recorded with the
  final candidate commit.
```

```text
Date: 2026-09-04
Task: A6/A7 fail-closed closeout (main agent)
Finding: Four residual defects surfaced while closing out the A6/A7 rebase repair:
  (1) PUT /api/settings/preferences normalized the candidate from a hardcoded `version: 1` base without
      carrying memory/observability, so any section patch silently reset those sections (settings.ts
      route bug; route->file->reopen regression added in settings-routes.test.ts);
  (2) Desktop swallowed updateSessionModel failures (`catch(() => undefined)`), so a model-binding
      failure surfaced later as an opaque send failure instead of its real cause — now fails closed in
      App.tsx and NewSessionDialog.tsx with the error handed to the user;
  (3) onboarding retry after a failed custom-provider save left duplicate `custom-*` providers —
      provider id is now stable per onboarding run; updatePreferences promoted to a required
      DesktopDataSource member (Mock already implemented it);
  (4) Web ops client NewSessionPage silently failed without a default model — added Chinese guidance
      with a "设置默认模型" action (web remains ops/protocol client; no product-feature expansion).
Verification (main agent, independent): root tsc (tsconfig + tsconfig.build) pass; targeted suites
  46/46 (model-policy 29, model-policy-compat 7, message-model-policy 1, settings-routes 9); full root
  vitest 2195/2195 (184 files); desktop tsc+build and vitest 58/58; web vitest 428/428 (34 files);
  Electron true-chain @smoke 1 passed (16.0s). verify-pi-sdk-imports and web:build run at commit time.
Matrix: TICK-02 flipped to PASS (ticker/summary now assemble through selectSecondary in start.ts;
  session-settings.test.ts asserts the real selectSecondary wiring).
```

```text
Date: 2026-09-05
Task: A8 contract freeze (main agent, serial — shared-schema exception per development.md §一铁律 4)
Scope: src/contracts/usage.ts (USAGE_SOURCES/ROLES/CALL_STATUSES, UtilityCompletion, UsageQueryParams),
  migrations v14 (usage_records rebuilt as cross-source ledger: source main/subagent/utility,
  role primary/secondary, six terminal statuses, nullable session/turn for global utility calls,
  dedupe_key UNIQUE with per-source key spaces, existing rows backfilled main/primary/completed,
  agent/thread/run/call left NULL = unknown), UsageStore (record with source/role/status/identity,
  summaryFiltered with days/source/role/agent/session/provider/model filters + bySource/byRole/byStatus,
  sessionTotals keeps turns semantics and adds calls, summary(days) kept as compat entry).
Verification (main agent, independent): new tests/integration/usage-store-v14.test.ts 6/6
  (v13→v14 rebuild preserves rows + backfill, per-source dedupe idempotency, filters, session totals);
  existing usage-api 15/15 + usage-recorder green; root tsc pass. Commit 777521a.
```

```text
Date: 2026-09-05
Task: A8 parallel lanes (parallel_group: wave-a-usage-lanes; A8a ingestion / A8b query API / A8c Desktop UI)
parallel eligibility: schema/contract frozen in 777521a; file sets disjoint (A8a: usage-recorder/
  complete-text/start.ts/subagents terminal/events.ts; A8b: routes/usage.ts; A8c: desktop/*) — verified
  by main agent before dispatch and after merge.
A8a (subagent + main review): completeUtilityText returns UtilityCompletion {text, usage|null}
  (null = runtime provided no accounting, never fabricated 0; invalid stopReason throws
  UtilityTextCallError carrying available usage; abort recognized); start.ts completeText wrapper
  records source=utility rows (callId=uuid, startedAt/finishedAt, status completed/failed/cancelled,
  provider/model/role from selectSecondary result, sessionId via new optional context; consumers still
  receive string — service interfaces unchanged); UsageRecorder consumes turn.completed/failed/
  cancelled/interrupted (completed without usage still not recorded; non-success rows with no
  accounting record 0 = no accounting per spec); agentId resolved via sessionService.getView;
  event-mapper stashes turn_end usage/context and attaches turnId+usage to failed/cancelled terminal
  payloads (contracts/events.ts additive optional fields only); subagent ingestion at
  RunStore.completeRun via injected hook (all six terminal dispositions mapped, dedupe run:<runId>,
  ingestion failure never affects run terminal state, composition wires UsageStore);
  OUT-OF-OWNS APPROVED BY MAIN AGENT: event-mapper.ts (brief req 4 required it; owns list omission
  was main-agent error), prompt-events.test.ts one-line assertion aligned to new contract (failed
  turn now records one main row).
A8b (subagent + main review): GET /api/usage/summary accepts days/source/role/agentId/sessionId/
  providerId/modelId (strict enum validation 400 on bad source/role, trim/empty→unset for text
  params); response keeps all 7 legacy fields and adds calls/bySource/byRole/byStatus;
  session endpoint adds calls. No changes to app.ts registration signature.
A8c (subagent + main review): Desktop usage page (sidebar "用量" entry + PageId) with 7/30/90-day,
  source (主对话/子代理/后台任务) and role (主模型/次级模型) filters; totals card + per-source/status/
  model/date groups; loading/error(retry)/empty states; data-testid oc-usage-*/oc-sidebar-usage;
  Mock fixture filters truthfully; IPC parses contract defensively; no cost anywhere (negative
  assertion in test). OUT-OF-OWNS APPROVED BY MAIN AGENT: errors.ts +2 lines ("loadUsage" error
  context) — correct errors.ts pattern, avoids wrong "日志加载失败" copy.
Main-agent verification on merged tree (independent rerun): root tsc PASS; usage suites 60/60
  (ingestion 10, recorder 11, store-v14 6, api 33); desktop tsc + vitest 62/62 (13 files) + build PASS;
  web vitest 428/428; web:build + desktop:build + verify-pi-sdk-imports PASS; full root vitest
  result recorded in .tmp/a8-full-vitest.log at commit time.
Known limitations (explicit, not silent): call-level detail list endpoint not built (backlog, noted
  by A8b); L6 true-chain usage rows (spawn → usage_records) to be covered in wave follow-up; byStatus
  ties have no stable secondary sort (consumers must not depend on tie order).
```

```text
Date: 2026-09-05
Task: A9 wave integration gate (main agent, serial)
Gates (all run separately on the merged tree, exit codes recorded):
  node scripts/verify-pi-sdk-imports.mjs → PASS
  npx tsc --noEmit -p tsconfig.json → PASS
  npx tsc -p tsconfig.build.json → PASS
  npx vitest run (root, full) → 186 files / 2233 tests PASS (.tmp/a8-full-vitest.log)
  npm run test --workspace=web → 34 files / 428 tests PASS
  npm run web:build → PASS | npm run desktop:build → PASS
  cd web; npx playwright test → 59/60, 1 FAIL investigated and fixed (see below); phase8 rerun 18/18
  desktop Electron true-chain full suite (9 specs / 24 tests) → 24 PASS in 6.4m (.tmp/a9-desktop-truechain.log)
A9 finding and fix: web phase8 test "e. 首次发送只创建一次" set defaults.model as the legacy string
  "fixture-provider:fixture-model"; the settings route has always required {providerId, modelId}
  (400), so the default was never persisted. Before the A6 closeout the page sent anyway; after the
  fail-closed change the page correctly showed "请先在设置的默认对话中选择默认模型" and blocked
  sending — product behavior verified correct by the failure screenshot/alert. Fixed the test to the
  object form (same as line 231) with an explanatory comment; single test and full Phase 8 spec
  (18/18) rerun green. No production change.
Exit-condition status against plan §8: matrix coverage complete (92 rows; 0 FAIL, 0 BLOCKED-ENV;
  remaining SKIPs are explicit and bounded: WS-04/SHELL-04 L5 unbuilt, SHELL-02 L6 unbuilt, SUPV-03
  deferred to CI-verified desktop-smoke, REL-01/02/03 install/update evidence pending G2 release,
  SUB-04/USAGE-02 L6 true-chain rows recorded as wave follow-up). Two-tier policy unified (A6/A7);
  usage queryable by source/role/model/agent/session/time incl. non-success (A8); diagnostics
  correlate one real failure path (A5, tr-608b3ef3); Desktop Mock + true-chain suites repeatable
  with CI smoke job configured.
Remaining for wave closeout: merge the stacked PR chain (#44→#45→#51→#52→#53) so CI triggers on
  main; release/install evidence stays a G2 item, not a Wave A blocker.
```

## 8. Wave A exit conditions

- The matrix covers all current modules, functions and detailed interactions, including known empty/error/recovery paths.
- Desktop Mock and Electron true-chain suites are repeatable and have CI smoke coverage.
- The cwd fallback is merged and the preferences persistence defect has a route/file/reopen regression.
- Every main/background model caller uses the canonical primary/secondary policy.
- Token usage is queryable by source, role, model, Agent, Session and time range, including non-success calls where usage is available.
- Desktop diagnostics correlate at least one real failure from visible UI to runtime records without sensitive data.
- Remaining unsupported features are explicit backlog/spec items rather than implicit assumptions.
- No Wave A completion claim is made from planning, code merge or CI success alone; real Desktop interaction evidence is required.

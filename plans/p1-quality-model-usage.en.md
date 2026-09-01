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

## 8. Wave A exit conditions

- The matrix covers all current modules, functions and detailed interactions, including known empty/error/recovery paths.
- Desktop Mock and Electron true-chain suites are repeatable and have CI smoke coverage.
- The cwd fallback is merged and the preferences persistence defect has a route/file/reopen regression.
- Every main/background model caller uses the canonical primary/secondary policy.
- Token usage is queryable by source, role, model, Agent, Session and time range, including non-success calls where usage is available.
- Desktop diagnostics correlate at least one real failure from visible UI to runtime records without sensitive data.
- Remaining unsupported features are explicit backlog/spec items rather than implicit assumptions.
- No Wave A completion claim is made from planning, code merge or CI success alone; real Desktop interaction evidence is required.

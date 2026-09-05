# P1 Wave B: Conversation Workbench

**Status:** 进行中（B0 semantics frozen 2026-09-05; B1-B7 not started）  
**Date:** 2026-08-31  
**Authoritative product spec:** [`docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md`](../docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md)  
**Current status:** [`docs/project-status.md`](../docs/project-status.md)  
**Related Wave A:** [`plans/p1-quality-model-usage.en.md`](p1-quality-model-usage.en.md)

## 1. Scope and non-goals

This is a P1 internal wave for a mature conversation workbench. It covers controlled Session branch/tree/fork operations, edit-and-regenerate and retry semantics, a linear current-branch timeline, readable Desktop compaction summaries, and durable session-owned plan/todo.

It does not implement browser capability, web search/fetch, cron, a general project-management workbench, or arbitrary PI RPC exposure. Message bodies remain in PI JSONL; SQLite stores only metadata/index/state needed for navigation and recovery. The existing Web timeline is a reference and protocol client, not the product frontend.

## 2. Existing capability and constraints

PI SDK (0.80.10) exposes branch/tree/fork/reset primitives on `SessionManager`; turn navigation (`navigateTree`) lives on `AgentSession`, one layer up. OpenColorful's adapter currently exposes none of them: `wrapSessionManager.getEntries()` flattens the current branch to id-less `PiMessageEntry`, and `PiAgentSessionHandle` exposes only prompt/steer/followUp/isStreaming/abort/compact. The server has session/message/abort/compact routes (409 `SESSION_BUSY` convention already established) and no branch/fork/retry endpoints; the `sessions` table has no branch metadata. The Desktop projector handles compact lifecycle but renders it as a one-line status event and omits the summary body. Web has a linear timeline derived from current-branch turns with per-user-message anchors. `plan.updated` is a declared/projected contract with zero emitters; there is no first-party durable todo writer/store/route.

The implementation must preserve:

- only `src/pi-sdk/` imports PI packages;
- PI JSONL as message and branch-history fact source;
- SQLite as metadata/index/event state, not message-body storage;
- Replay Store before broadcast and strict per-stream sequence;
- Server-first and Desktop-first product boundaries;
- isolated faux-provider tests and independent quality-gate commands.

## 3. Product contract (FROZEN at B0, 2026-09-05)

The semantics in this section are frozen. Any change requires a Feature Spec amendment before implementation. Button labels and small presentation details may be `agent-recommends` only where they do not change the underlying state transition. PI facts below were verified against the installed `@earendil-works/pi-coding-agent` 0.80.10 (`references/pi` source: `packages/coding-agent/src/core/session-manager.ts`, `agent-session.ts`).

### 3.1 Stable identifiers

| Identifier | Definition | Durability |
|---|---|---|
| `sessionId` | existing SQLite `sessions.id` (unchanged this wave) | durable |
| `entryId` | PI `SessionEntry.id` (8-hex, `parentId`-linked, immutable; JSONL is append-only) | durable |
| `branchId` | the `entryId` of a branch's leaf entry; `"root"` for an empty session. Derived, never stored (except the branch head below) | derivable forever from JSONL |
| `turnId` | `turn-<userEntryId>` where `userEntryId` is the user message entry that starts the turn | deterministic across restarts |
| branch head | `sessions.branch_head_entry_id` (SQLite metadata; NULL = PI default, i.e. file-order last entry) | durable |

A "turn" = one user message entry plus all following entries on the same branch path until the next user message entry; compaction/label entries on the path appear as turn-boundary items. Turn grouping is derived from entry order on the branch path, never stored.

### 3.2 Frozen action semantics

**Regenerate is one primitive shared by 回退并修改 and 重试.** Both branch at the same point and differ only in the appended text.

1. **Regenerate (edit-and-regenerate / retry)**
   - Trigger: user acts on a user message (edit: new text; retry: original text) or on an assistant result (retry; the server resolves it to that turn's user entry).
   - Preconditions: session not archived (else 409); not busy — `isBusy` covers the active turn stream and compaction (else 409 `SESSION_BUSY`); target entry exists (else 404) and is a user message entry (else 400).
   - Server steps, one runtime operation on the same SessionManager as the prompt flow: `branchTo(parentId(target))` — or `resetLeaf()` when the target is a root — then append the user message (new/original text) via the existing prompt flow; the turn runs on the normal session stream.
   - Result: 202 `{status:"accepted", sessionId, streamId, branchId}`; a new sibling branch under the same parent; the old branch and its outputs are untouched.
   - Persistence: JSONL append-only; branch head refreshed to the new leaf.
   - Replay: identical to any prompt turn (per-stream sequence unchanged).
   - Recovery: a crash mid-turn leaves the appended user entry plus partial assistant entries (same semantics as a crashed prompt today); reopen lands on the file-order last entry, which is the regenerated branch.

2. **Fork**
   - Trigger: user picks “Fork 成独立会话” for the session (optionally at a selected entry; default = current leaf).
   - Preconditions: not busy, not archived; the source session has at least one entry (empty source → 400).
   - Steps: on a DETACHED `SessionManager.open(sourcePath)` instance call `createBranchedSession(target)` — PI mints a new session id/file and writes a `parentSession` header — then create a new SQLite session row with source metadata (`sourceSessionId`, `sourceLeafEntryId`, title suffix).
   - Result: 201 with the full new `SessionView`; the source session's runtime is untouched (PI replaces only the instance it is called on); the new session is fully independent (title/model/archive/archive-path).
   - No event is emitted on the source stream; clients navigate to the new session from the response.

3. **Branch switch**
   - Trigger: user selects an existing branch in the switcher.
   - Preconditions: not busy, not archived; `branchId` resolves to a leaf entry in the tree (else 404).
   - Steps: `branchTo(targetLeafEntryId)`; persist `branch_head_entry_id`; emit `session.branch.switched {branchId}` on the session stream; also emit `session.branches.changed {reason:"switch"}`.
   - Persistence rule (frozen): on runtime open, apply the stored head ONLY when the file-order last entry is NOT a descendant of it; if it is a descendant, an append happened after the switch and the file-order last entry wins. Prompt/regenerate refresh the stored head.
   - Continuing the conversation after a switch appends on that branch, which thereby becomes the current branch.

4. **Compaction display (no server behavior change)**
   - Desktop consumes the existing `session.compacting`/`session.compacted` payloads, including `summary` (already server-sanitized to ≤500 chars), `tokensBefore`, `tokensAfter` (an estimate — UI labels it 约), `aborted`, `errorMessage`.
   - Card states: compacting (in progress); completed (tokens before→after + summary body, expand/collapse, long summaries collapsed by default, no extra client-side truncation); not-completed distinguishing 已中止 (`aborted`) from 失败 (`errorMessage`); no-op and busy surface as the existing 409 composer errors (“当前会话无需压缩” / “会话正在生成，无法压缩”), not as cards.
   - Summary text must not be written to logs.

5. **Durable session todo**
   - Ownership: todos belong to the session and are written ONLY by the first-party tool inside turn execution (session single-flight serializes writers). Desktop/Web UIs are read-only projections in this wave — no UI write path.
   - Item: `{content, status: pending|in_progress|completed|cancelled, priority: high|medium|low, activeForm?}`; list order = array order.
   - Write semantics: whole-list replacement in ONE SQLite transaction (`session_todos`, PK `(session_id, position)`); the empty list is a legal explicit clear; on success publish `todo.updated {items}` on the session stream (Replay Store first); the tool result tells the model whether the write was accepted.
   - The store does not enforce one-in-progress; the tool description requests at most one `in_progress` (Codex pattern); the UI shows the first `in_progress` as the active item.
   - Recovery: state loads from SQLite on session open/restart; replaying `todo.updated` re-projects the same list.

6. **`plan.updated`**: contract unchanged (`{items: string[]}`); it remains a reserved projection type, is NOT the durable todo, and gains no emitters this wave. `todo.updated` is the durable surface.

7. **Linear timeline vs branch switcher (two views, unchanged split)**: the linear timeline locates turns of the CURRENT branch (click scrolls/highlights, stable anchors from `entryId`/`turnId`); the branch switcher lists branches and parent/child relationships and performs switches. Neither view morphs into the other.

### 3.3 API/event contract draft (B2 implements; the contract is frozen, exact paths are `agent-recommends`)

- `GET /api/sessions/:id/tree` → `{currentBranchId, branches: [{branchId, leafEntryId, leafPreview, entryCount, updatedAt, isCurrent}]}` — metadata and short previews only, no message bodies.
- `GET /api/sessions/:id/entries?branchId=` → ordered entries of the branch path root→leaf: `{entryId, parentId, turnId, type, role?, text, timestamp, toolCalls?}` — additive to the existing `PiMessageEntry` flattening (toolCall results keep the 500-char truncation); both frontends migrate to this. `SessionView.messageEntries` stays for compatibility this wave.
- `POST /api/sessions/:id/regenerate` `{targetEntryId, text}` → 202 `{status:"accepted", sessionId, streamId, branchId}`.
- `POST /api/sessions/:id/fork` `{targetEntryId?}` → 201 full new `SessionView`.
- `POST /api/sessions/:id/branch/switch` `{branchId}` → 200 `{branchId}`.
- Session-stream event additions (envelope `protocolVersion` stays 1; Replay Store write-before-broadcast unchanged): `session.branch.switched {branchId}`, `session.branches.changed {reason: "regenerate"|"fork"|"switch"}`, `todo.updated {items}`. Compaction events stay on the separate `ctrl-` control stream.
- Desktop IPC parity: `*Wire` mappings for the new endpoints/events ship in the same changes that add them.

### 3.4 Error and concurrency matrix

| Condition | HTTP | Code | User-visible (Chinese) | Client next step |
|---|---|---|---|---|
| Regenerate/switch/fork while a turn streams or compaction runs | 409 | SESSION_BUSY | 会话正在运行，请先停止后再操作 | offer 停止; never auto-abort |
| Target entry/branch not found (incl. stale references) | 404 | NOT_FOUND | 引用的会话节点不存在，请刷新后重试 | refresh tree |
| Malformed body; empty text; regenerate target not a user message; fork of an empty session | 400 | INVALID_INPUT | specific Chinese message | fix input |
| Session archived | 409 | CONFLICT | 会话已归档 | unarchive first |
| Two clients switch branches concurrently | 200 | — | last write wins; both clients receive `session.branch.switched` | the other client reloads via the event |
| Concurrent todo writes | — | — | impossible by construction (tool-only writes, serialized by session single-flight) | — |
| Background memory review vs regenerate | — | — | the review snapshots its branch revision; a later regenerate may orphan it; review output is advisory only | none |

### 3.5 Frozen architecture decisions (with rationale)

1. Regenerate uses leaf primitives (`branch()` + next append), NOT `AgentSession.navigateTree()` — avoids extension-hook and branch-summary complexity and cannot leave a dangling leaf, because branch move and append happen in one server operation.
2. Branch choice persists in SQLite (`sessions.branch_head_entry_id`), not JSONL markers: PI does not persist the leaf (reopen = file-order last entry, `_buildIndex`), and append-only JSONL must not be polluted with marker entries. SQLite metadata is the allowed boundary.
3. Fork runs on a detached SessionManager instance so the source runtime is never replaced (PI `createBranchedSession` replaces its own instance in place).
4. `branchId` = leaf entry id: PI has no branch entity; OpenHanako uses the same convention.
5. Migration v15 is a SINGLE serial migration owned by B2 (sessions branch-head columns + `session_todos` DDL); B5 owns the store/DAO/tool/route/UI on top of it. No parallel task may add migration DDL.
6. Web receives additive contract support only (types + e2e stability); it is not a product frontend in this wave.

### 3.6 Left to `agent-recommends`

Endpoint path spellings within the frozen contract; the todo tool's internal name (suggestion `todo_write`); button labels and icons; branch-switcher placement (chat-head popover recommended); summary collapse threshold; switcher visual design.

Any change to these semantics requires a Feature Spec amendment before implementation.

## 4. Dependency graph and integration barriers

```text
B0 (product/API semantics, serial)
  -> B1 (PI adapter) || B2 (metadata/API/migration)
      -> B3 (Desktop branch switcher + linear timeline)
      -> B4 (Desktop compaction summary)
      -> B5 (durable session todo)
          -> B6 (cross-surface integration)
              -> B7 (main-Agent acceptance and closeout)
```

B0 is serial because it fixes user-visible state transitions and stable identifiers. B1 and B2 can be parallel only after B0 and with disjoint ownership; migrations and route registry files must be assigned explicitly. B3/B4/B5 may be parallel after their APIs/events are stable and file ownership is disjoint. B6 is the integration barrier for replay, persistence, Desktop Mock/IPC parity and cross-client behavior. B7 is serial and cannot be delegated as final acceptance.

## 5. File ownership map

| Task | Planned ownership | Explicitly excluded |
|---|---|---|
| B0 | Feature Spec, contract notes, state-transition matrix | Production implementation |
| B1 | `src/pi-sdk/` controlled adapter and adapter tests | Server routes, storage migration, Desktop UI |
| B2 | Session metadata/store, migration v15 (serially includes `session_todos` DDL), routes, event contract and integration tests | PI adapter internals and Desktop components |
| B3 | Desktop source/projector/timeline/branch components, styles and UI tests | Server branch semantics and persistence |
| B4 | Desktop compact projector/detail components, fixtures and UI tests | Compact runtime defaults and event schema unless B0 assigns a compatibility change |
| B5 | Todo contract/tool/store/route/event/projection/UI and focused tests by sub-lane | Browser, cron and unrelated plan concepts |
| B6 | Integration fixtures/scripts/evidence only | New semantics and unreviewed schema changes |
| B7 | Main-Agent quality gates, real Desktop acceptance, status and implementation log | Delegated acceptance claims |

Exact paths must be re-read and assigned in the dispatch brief; no parallel task may touch a shared migration, schema, route registry or `DesktopDataSource` contract without an explicit barrier.

## 6. Task briefs

### B0 — Product semantics and Session-tree contract

- **role:** Freeze user-visible state transitions before exposing PI primitives.
- **read_first:** This spec, PI SessionManager/type definitions and reference implementation, `src/pi-sdk/agent-session.ts`, wrapper/types, session service/routes/messages, JSONL branch reader, Web timeline and Desktop projector.
- **owns:** Product Feature Spec, API/event contract draft, stable entry/turn/branch/session identity definitions, error and concurrency matrix.
- **forbidden:** No production code, no UI implementation, no direct PI RPC exposure.
- **interface:** Define edit/retry/fork/rollback state transitions, branch retention, running-session behavior, summary rules and todo ownership. Define which identifiers are durable and which are ephemeral.
- **requirements:** Keep product semantics separate from PI API names; specify 400/404/409 and stale-reference behavior; preserve JSONL/SQLite facts boundary.
- **acceptance:** Every user action has a success, failure, persistence, replay and recovery definition; main Agent confirms no unresolved product decision blocks B1-B5.
- **decision_mode:** `human-fixed` for the requested mature capabilities and Desktop-first boundary; `agent-recommends` for labels and minor presentation details.
- **report:** Contract table, dependency review, open risks and approval state in the plan log.
- **docs:** Update the Chinese Feature Spec before implementation; add an ADR only for a durable architecture choice.

### B1 — Controlled PI Session adapter (`parallel_group: wave-b-session-contract`)

- **role:** Expose only the approved branch/tree/fork/reset/navigation operations through the existing PI adapter boundary.
- **read_first:** B0 contract, `src/pi-sdk/index.ts`, `agent-session.ts`, `types.ts`, session-manager registry and PI SessionManager source/types.
- **owns:** PI adapter additions and adapter/unit/contract tests under the assigned `src/pi-sdk/` boundary.
- **forbidden:** No duplicate SessionManager, no server route/storage edits, no UI changes, no raw PI package imports outside `src/pi-sdk/`.
- **interface:** Adapter methods return platform-safe identifiers/results and stable typed errors; running-session and stale-reference refusal is explicit.
- **requirements:** Map only the product-approved operations; preserve JSONL history and branch revision facts; support restart/open behavior required by B0.
- **acceptance:** Import-boundary verification passes; adapter tests cover branch/tree/fork/reset/navigation, invalid references, running rejection and recovery; no raw PI types leak into unrelated modules.
- **decision_mode:** `human-fixed` for the adapter boundary; `agent-recommends` for internal method names.
- **report:** Fixed child report plus independent main-Agent diff review.
- **docs:** Update the technical plan and architecture/adapter note if the public platform contract changes.

### B2 — Session metadata, API, migration and Replay (`parallel_group: wave-b-session-contract`)

- **role:** Persist branch/session relationships and expose HTTP/event contracts without copying message bodies.
- **read_first:** B0 contract, session service/routes, migrations, SQLite stores, Replay Store, event contracts and integration tests.
- **owns:** Assigned metadata schema/store/migration, routes, route tests, event mapping and integration tests.
- **forbidden:** No PI adapter edits, no message-body duplication, no Desktop component changes, no silent migration data loss.
- **interface:** Provide branch/fork/rollback/edit/retry endpoints and events as approved by B0; return stable 400/404/409 errors; write Replay before broadcast.
- **requirements:** Forward-compatible migration, old-session read behavior, restart recovery, idempotent operation handling and explicit parent/source metadata for Fork.
- **acceptance:** API contract and integration tests cover happy/negative/concurrent/restart cases; SQLite contains metadata only; JSONL remains the source of message and branch history; replay sequence is strict.
- **decision_mode:** `human-fixed` for facts/storage/event boundaries; `agent-recommends` for endpoint naming within the approved contract.
- **report:** Migration version, SQL evidence, endpoint results, replay evidence and unresolved compatibility concerns.
- **docs:** Update the Feature Spec/plan and migration or architecture documentation as required by the impact matrix.

### B3 — Desktop branch switcher and linear timeline

- **role:** Make branch history and current-branch navigation usable in the product frontend.
- **read_first:** B0-B2 contracts, Desktop source/projector/chat components, existing Web timeline derivation, styles and MockDataSource.
- **owns:** Desktop source methods, projector/view model, branch switcher, linear timeline components/styles, fixtures and UI tests.
- **forbidden:** No server semantics, no persistence schema, no self-authored branch mutations outside the approved source contract.
- **interface:** Consume stable branch/entry/turn IDs; expose loading, empty, stale, error, current-node and running-session states.
- **requirements:** Clicking a linear timeline item scrolls/highlights the current branch entry; branch switcher shows old branches and source relationships; refresh/restart/replay preserve selection where valid.
- **acceptance:** Mock and Electron tests cover edit/retry/fork navigation, branch retention/switch, long conversation, narrow view, stale refs, error recovery and live/replayed events; API/JSONL truth is compared.
- **decision_mode:** `human-fixed` for two-view responsibility; `agent-recommends` for visual details and labels.
- **report:** UI evidence paths, selectors used, screenshot/trace results and parity gaps.
- **docs:** Update plan implementation log and Desktop design/test documentation; no Web product expansion.

### B4 — Desktop compaction summary body

- **role:** Surface the actual generated summary in the product UI.
- **read_first:** B0 contract, compact route/control stream, event contract, `src/pi-sdk/agent-session.ts`, Desktop projector/components, Web CompactionCard and fixtures.
- **owns:** Desktop compact projection/detail components, state fixtures and Mock/Electron tests.
- **forbidden:** No silent change to automatic compaction defaults; no event-schema fork; no raw sensitive summary logging.
- **interface:** Consume existing `session.compacting/session.compacted` payload, including summary, token counts, aborted and error fields.
- **requirements:** Render success summary body with expand/collapse; distinguish compacting, failed, cancelled, no-op and busy; define display length and redaction rules before coding.
- **acceptance:** Live and replayed completion cards show identical summary body and token transition; all negative states have readable next actions; long summary and empty summary do not break layout.
- **decision_mode:** `human-fixed` for visible summary requirement; `agent-recommends` for collapse default and typography.
- **report:** State matrix, screenshots/traces, and evidence that the existing payload is reused.
- **docs:** Update Feature Spec/plan if length or redaction policy becomes a durable rule; Changelog only for the user-visible Desktop change.

### B5 — Durable session-owned plan/todo

- **role:** Turn projected plan events into a real, persistent, controlled session tool.
- **read_first:** B0 contract, existing `plan.updated` event/projector, OpenCode todo schema/store/tool, OpenHanako SessionTodoCard, Codex plan types, storage/migration/event conventions.
- **owns:** Todo schema, first-party `todo_write`/equivalent tool, SQLite store/migration, route/event, Desktop projector/UI and assigned tests; shared migration ownership must be serially assigned.
- **forbidden:** No UI-only fake state, no unbounded arbitrary task payloads, no browser/cron integration, no replacement of `subagent_runs` or plan event history.
- **interface:** Session-owned whole-list replacement with `pending/in_progress/completed/cancelled`, priority, activeForm, validation, optimistic/version check, transaction, `todo.updated` Replay event and Desktop projection.
- **requirements:** Define empty-list semantics, one-active-item policy if chosen, concurrent update behavior, retry/replay behavior, restart load and failure rollback. The tool result must tell the model whether the write was accepted.
- **acceptance:** Tool → store → event/replay → Desktop → reload/restart works in Mock and Electron; invalid states, empty/replaced list, concurrent writers, disconnect, multi-client replay and failed transaction are tested.
- **decision_mode:** `human-fixed` for session ownership and persistence; `agent-recommends` for active-item constraint and small UI details.
- **report:** Schema/migration evidence, tool transcript, event sequence, UI screenshots and failure-path output.
- **docs:** Update Feature Spec, plan, migration docs and Changelog for the visible Todo surface.

### B6 — Cross-surface integration

- **role:** Prove that branch, timeline, compaction and todo behavior remains coherent across runtime, API, Replay and Desktop.
- **read_first:** B1-B5 reports/diffs, all contracts/migrations, Mock and Electron harnesses, Wave A test conventions.
- **owns:** Integration fixtures/scripts, cross-feature tests and evidence index only.
- **forbidden:** No new product semantics, no patching production behavior during acceptance without a new assigned task.
- **interface:** Use isolated home, faux Provider, stable IDs and API/JSONL/SQLite truth comparisons; preserve Replay ordering.
- **requirements:** Cover branch after compact, todo after reload, timeline after branch switch, replay after disconnect, and operation rejection while a turn runs.
- **acceptance:** Cross-feature API and UI flows pass or have explicit bounded defects; no stale projector state after reload/restart; evidence links resolve.
- **decision_mode:** `human-fixed` for integration scope; `agent-recommends` for fixture arrangement.
- **report:** Main-Agent-reviewed integration report with commands, exit codes and artifacts.
- **docs:** Append implementation evidence and deviations to this plan; update status only after B7 closeout.

### B7 — Main-Agent acceptance and closeout

- **role:** Independently decide whether Wave B is complete.
- **read_first:** All B artifacts, `docs/development.md` quality gates, current project status, release/test docs and user-visible changelog requirements.
- **owns:** Independent command runs, real Desktop walkthrough, screenshots/traces, final implementation log and status updates.
- **forbidden:** No delegated acceptance, no aggregate “green” claim that hides skips or environment blocks, no five-day-use claim without all exit conditions.
- **interface:** Run individual root, Web, Desktop, Replay, migration and Electron commands; compare visible behavior with API/JSONL/SQLite facts.
- **requirements:** Record quality gates separately, use genuine user interactions, preserve known differences and keep unsupported behaviors explicit.
- **acceptance:** All B exit criteria are evidenced; only then may the plan status change from Planning to Completed and may five-day daily-use be considered together with Wave A and release evidence.
- **decision_mode:** `human-fixed` for completion evidence and status language.
- **report:** Main-Agent final evidence index and deviation list.
- **docs:** Update `docs/project-status.md`, Feature Spec and `CHANGELOG.md` for user-visible changes; do not rewrite historical plans.

## 7. Quality gates

Commands are run one at a time with exit codes and result artifacts. The exact base gates follow `docs/development.md` and Wave A. B-specific evidence includes API contract/integration tests, migration/reopen, Replay sequence assertions, Desktop Mock, Electron true-chain, screenshots/traces, and API/JSONL/SQLite comparisons. A child-agent report is not acceptance evidence.

## 8. Implementation log template

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

### B0 implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B0 product semantics and Session-tree contract freeze (integration barrier for B1/B2)
Commit(s): docs-only change on p1-wave-b-b0-contract; sha recorded in the merge commit.
Commands and exit codes: no production code changed. Inputs: four read-only exploration
  reports (PI session model 0.80.10; OpenColorful backend; Web/Desktop frontend; reference
  repos opencode/openhanako/codex/hermes-agent), retained in the session transcript.
Evidence paths: this plan §3 (frozen contract) and §2 (verified capability gaps);
  docs/superpowers/specs/2026-08-31-p1-conversation-workbench.md §三 (frozen product semantics).
Observed result: semantics frozen for regenerate (edit+retry unified), fork, branch switch,
  compaction display, durable todo; stable identifier table; API/event contract draft;
  error/concurrency matrix; v15 single-serial-migration assignment (B2 owns DDL, B5 builds on it).
Open risks: (1) the branch-head apply rule (§3.2.3) relies on PI rebuilding the leaf as the
  file-order last entry — to be proven behaviorally by B1 adapter restart tests; (2) PI
  tokensAfter is an estimate — UI must label it 约; (3) a regenerate may orphan an in-flight
  background memory review (advisory only, accepted); (4) B2 codes against the frozen adapter
  interface in §3.3 before B1 lands — integration is proven at merge and re-proven in B6.
Unverified: none beyond the risks above.
Deviation and follow-up: none.
Main-Agent review: B0 accepted; B1/B2 parallel dispatch approved with disjoint ownership
  (B1: src/pi-sdk only; B2: server/runtime/storage only; neither touches the other's files).
```

### B1 implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B1 controlled PI session-tree adapter (branch p1-wave-b-b1-pi-adapter, PR #56)
Commit(s): 6135873 (adapter), dc8a03b (tests), plus this docs-sync commit.
Commands and exit codes: npx tsc --noEmit → 0; npx vitest run tests/contract/session-tree.test.ts
  tests/contract/pi-sdk-adapter.test.ts → 16/16 passed; node scripts/verify-pi-sdk-imports.mjs → 0;
  git diff --check → 0. Full integration gates are run by the main agent at merge.
Evidence paths: src/pi-sdk/session-tree.ts; src/pi-sdk/index.ts (additive exports +
  flattenMessageEntries extraction); tests/contract/session-tree.test.ts (7 tests).
Observed result: frozen interface implemented with ZERO name/signature deviation. Verified PI
  facts: createBranchedSession returns the new file path (undefined only in-memory), writes to the
  source instance's sessionDir with header parentSession = source path, and DELAYS file creation
  when the path has no assistant message — forkSessionToNewSession therefore force-flushes once
  (source file never rewritten, proven byte-identical in tests). Reopen leaf = file-order last
  entry behaviorally confirmed (test 6), proving the B0 §3.2.3 persistence-rule precondition.
  Governance note: the first CI run failed docs-sync (production change without plans/ update);
  this record is the required closeout.
Unverified: none.
Deviation and follow-up: fork maps unknown targetLeafEntryId to entry_not_found and empty source
  to invalid_target (aligns B0 §3.4 instead of leaking PI raw errors); toolResult entries'
  own text uses the existing 500-char truncation; branch_summary text is "" per §3.1. The
  force-flush reaches PI's internal `flushed` flag the same way handle.persist() does — revisit
  on PI SDK upgrades.
Main-Agent review: diff independently reviewed (flattening extraction is faithful; existing
  9/9 contract tests green); accepted. B2 may code against the exported adapter surface.
```

### B2 implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B2 session metadata/API/migration v15/events (branch p1-wave-b-b2-session-api)
Commit(s): 1b42856 (branch API + migration v15 + events) and 677a8cd (shared runtime
  bootstrap extraction fix), rebased onto main after B1 merged (PR #57).
Commands and exit codes: lane verification — npx tsc --noEmit → 0; targeted vitest files
  (migration v15, branch api, fork, bootstrap) all → 0; full npx vitest run → 191 files /
  2260 tests passed; scripts/verify-pi-sdk-imports.mjs → 0. Main-Agent reruns full gates
  at merge.
Evidence paths: src/storage/migrations.ts (v15), src/storage/session-index.ts,
  src/runtime/session-runtime.ts (regenerate/switchBranch/head rule), src/runtime/session-service.ts
  (tree/entries/fork), src/server/routes/session-branches.ts, src/server/routes/runtime-bootstrap.ts,
  src/contracts/session-branch.ts + events.ts, tests/integration/session-{migration-v15,
  branch-api,fork,branch-bootstrap}.test.ts.
Observed result: regenerate unifies edit-and-retry through the shared prompt path
  (single-flight, identical turn events); branch head persisted per B0 §3.2.3 (apply rule
  verified: descendant-of-head → file-last wins); fork on detached instance with source
  metadata; tree/entries with turn-<userEntryId> grouping; migration v15 idempotent
  (v9/v12 precedent) with session_todos DDL for B5. Review found and FIXED one defect:
  the lane's simplified lazy runtime creation would have silently dropped plugin/skill/
  subagent/memory wiring when the first action after restart was a regenerate — resolved
  by extracting messages.ts ensureRuntime VERBATIM into a shared runtime bootstrap used
  by both route groups (regression test proves full tool surface on restart+regenerate).
  Interpretations recorded: branch events use dedicated branch-<uuid> streams (same
  pattern as the existing ctrl- control streams; live delivery is per-session so
  multi-client sync holds; missed replays recover via GET tree/entries); branchId for
  regenerate is observed via pre-turn entry snapshot diff; sessions holding only
  session_info count as empty (fork 400).
Unverified: skill/subagent context wiring in the extracted bootstrap rests on the verbatim
  move plus existing wiring tests (no dedicated new-economy test) — B6 exercises them.
Deviation and follow-up: none beyond the interpretations above.
Main-Agent review: core accepted; ensureRuntime-lite defect fixed and re-verified
  (2260/2260); B3/B5a may start from this surface.
```

### B3 implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B3 Desktop branch switcher + linear timeline (worktree lane, branch p1-wave-b-b3-desktop)
Commit(s): b0dd924 (data layer + UI), 67a1558 (tests + turn-terminal anchor reload fix).
Commands and exit codes: npx tsc --noEmit → 0; desktop npx tsc -p tsconfig.tests.json --noEmit
  → 0; desktop full unit suite npx vitest run → 84/84; npx vite build → 0; lane true-chain
  npx playwright test lane-b3-branches.truechain.spec.ts → 3/3 (evidence under
  desktop/test-artifacts/pw-output/). Main-Agent independently re-ran all of the above → same
  results. Full integration gates run by the main agent at merge/B6.
Evidence paths: desktop/src/data/{source,ipc-source,mock-source,projector}.ts,
  desktop/src/components/{BranchSwitcher,TimelineNav,timeline-scroll,ChatView}.tsx,
  desktop/tests/unit/branch-data.test.ts, desktop/src/branch.mock.test.tsx,
  desktop/tests/e2e/lane-b3-branches.truechain.spec.ts + fixtures/pages.
Observed result: branch switcher (chat-head popover) and linear current-branch timeline with
  immutable entryId/turnId anchors; hover 编辑并重生成/重试 and fork wired to the B2 endpoints;
  409 busy (停止 action), 404 stale (刷新), archived, loading/empty/error states implemented;
  branch events consumed without disturbing prompt-stream adoption or the compact section
  (untouched for B4). True-chain asserts API/JSONL truth (append-only old branch, sibling
  branch current, branch head survives app restart) and fork source-integrity.
Deviation and follow-up: live-streamed turns reload entries at turn terminal events so new
  turns gain anchors (spec-correctness fix found by the true-chain lane, main-Agent reviewed
  in diff). One process incident: an exploratory git stash popped a PRE-EXISTING foreign
  stash; the lane aborted the apply with git reset --merge — stash and HEAD verified intact
  afterwards by the main agent; no data lost. Follow-up fix e718e6e: findByText timeout
  argument moved to the waitForElementOptions slot so the desktop MAIN tsc gate passes
  (the tests tsconfig exclude had masked it locally).
Main-Agent review: accepted pending CI; B4/B5b may build on this desktop structure.
```

### B5a implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B5a durable session todo backend (worktree lane, branch p1-wave-b-b5a-todo-backend)
Commit(s): 86f5ee3 (store + tool + bootstrap wiring + SessionView.todos + tests).
Commands and exit codes: npx tsc --noEmit → 0; lane tests (session-todo-store 7, session-todo-tool
  8, session-branch-bootstrap regression) → all pass; full npx vitest run → 193 files / 2275
  tests passed; scripts/verify-pi-sdk-imports.mjs → 0. Main-Agent independently re-ran
  tsc/targeted/boundary → same results. Full integration gates run by the main agent at merge/B6.
Evidence paths: src/storage/session-todos.ts, src/pi-sdk/todo-tools.ts,
  src/server/routes/runtime-bootstrap.ts (wiring), src/runtime/session-service.ts (todos view),
  src/server/start.ts, tests/integration/session-todo-{store,tool}.test.ts.
Observed result: todo_write tool (whole-list replacement; store-validated enums; bounded
  payloads; structured accepted/rejected result in Chinese) → SessionTodoStore single-transaction
  replace (empty list = legal clear, PK (session_id, position) from v15) → todo.updated on a
  stable per-session stream todo:<sessionId> with monotonic sequence, published through
  replayStore.publish (write-before-broadcast preserved) → SessionView.todos recovers state
  on open/restart. Registered whenever database exists (session-owned, no Agent binding),
  unregistered on runtime dispose (same wiring point as memory/skill).
Interpretations recorded: tool args schema keeps status/priority as loose strings so the
  STORE validates enums and the tool result reports Chinese rejections (PI would otherwise
  pre-validate with English errors before invoke — contract requires the model-facing result
  to carry the verdict); todo.updated payload still uses the frozen SessionTodoItemView schema.
Unverified: none backend-side; B5b consumes the UI surface.
Deviation and follow-up: the stale "no emitter" comment on todo.updated in events.ts remains
  (contracts were outside lane ownership) — main agent to update in integration.
Main-Agent review: accepted pending CI; merged as #59 (c206e44).
```

### B4 implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B4 Desktop compaction summary card (worktree lane, branch p1-wave-b-b4-compaction)
Commit(s): 86c81da (card + projection + tests). Note: the lane was implemented by the main
  agent after the subagent platform went down mid-run (an orphaned first-run agent left a
  clean partial data layer: projector + mock-data; reviewed, kept and completed by the
  main agent rather than redone).
Commands and exit codes: npx tsc --noEmit (root) → 0; desktop MAIN tsc --noEmit → 0
  (mandatory gate); desktop tsconfig.tests tsc → 0; desktop full unit suite → 18 files /
  92 tests passed; npx vite build → 0. True-chain compact lane deferred to B6/B7 evidence
  (live + restart-replay summary identity) — see deviations.
Evidence paths: desktop/src/components/{CompactionCard.tsx,CompactionCard.css},
  desktop/src/data/projector.ts (compaction card state machine: compacting→completed/
  aborted/failed, activeCompactionId pairing, history-entry isomorphism),
  desktop/src/mock-data.ts (CompactionItem + demo compaction entry), desktop/src/data/mock-source.ts
  (summary in compacted payload), tests: src/compaction-card.mock.test.tsx (4),
  tests/unit/compaction-projection.test.ts (4), updated branch-data/desktop-projector
  expectations.
Observed result: frozen display rules implemented — tokens labeled 约 (server estimate),
  long summaries collapsed by default with expand/collapse, no client-side truncation,
  aborted (已中止) vs failed (error line) distinguishable, no-op/busy produce no card
  (409 composer errors only), summary never logged (console assertion in tests); live
  events and history compaction entries share one card structure.
Unverified: Electron true-chain compact flow (live card + post-restart history identity).
Deviation and follow-up: lane-b4 true-chain spec deferred to B6/B7 (B6 explicitly covers
  "branch after compact" and B7 real-Desktop walkthrough); no server-side changes.
Main-Agent review: self-implemented under platform outage; full local gates green.

### B5b implementation record — 2026-09-05

```text
Date: 2026-09-05
Task: B5b Desktop SessionTodoCard (worktree lane, branch p1-wave-b-b5b-todo-ui)
Commit(s): b4fdde4 (card + projection + IPC seeding + Mock scenario + tests).
Implemented by the main agent (subagent platform outage); full local gates green.
Commands and exit codes: npx tsc --noEmit (root) → 0; desktop MAIN tsc --noEmit → 0;
  desktop tsconfig.tests tsc → 0; desktop full unit suite → 18 files / 94 tests passed;
  npx vite build → 0. True-chain todo lane deferred to B6/B7 evidence.
Evidence paths: desktop/src/components/{SessionTodoCard.tsx,SessionTodoCard.css},
  desktop/src/data/projector.ts (todos state + todo.updated gate outside the prompt-stream
  adoption + defensive item parsing), desktop/src/data/ipc-source.ts (SessionView.todos
  Wire seeding), desktop/src/data/mock-source.ts (scripted todo_write emulation on the
  demo session: first turn 2 items with one in_progress, second turn whole-list replace),
  desktop/src/components/ChatView.tsx (card slot above the timeline),
  tests: src/todo-card.mock.test.tsx (4), tests/unit/todo-projection.test.ts (6).
Observed result: read-only session todo card (no write-path buttons asserted), first
  in_progress shows activeForm, done/total counts completed+cancelled, empty list hides
  the card, todo:<sessionId> events never adopted by the prompt stream (seenStreams
  untouched), SessionView.todos recovers state on open/restart.
Unverified: Electron true-chain todo flow (faux turn with real todo_write tool call →
  live card → restart recovery).
Deviation and follow-up: true-chain evidence deferred to B6/B7 (B6 covers "todo after
  reload"; B7 real-Desktop walkthrough); web KNOWN_EVENT_TYPES for todo.updated left to
  B6 (web is the frozen protocol client).
Main-Agent review: self-implemented; full local gates green.
```

## 9. Wave B exit conditions

- Edit-and-regenerate, retry and independent Fork preserve old branches/outputs and survive refresh/restart.
- Running-session, stale-reference, invalid-node and missing-resource behavior is stable and visible.
- Linear current-branch timeline and separate branch switcher are usable and non-conflicting.
- Desktop shows compaction summary body from both live events and replayed history.
- Durable session todo has a real writer, persistence, event/replay, projection and recovery path.
- Migration, concurrency, multi-client and failure evidence is complete.
- Plan remains Planning until the main Agent has independently verified all evidence; planning, code merge or CI success alone never marks the wave complete.

# P1 Slice 1.75 Implementation Plan — Memory Activation

**Date:** 2026-08-28
**Status:** All tasks merged (2026-08-28 — PR #31 T12+T13 / #32 T14 / #33 T15); awaiting author daily-use observation of memory trigger rates
**Spec (authoritative, Chinese):** `docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`
**Extends:** slice 1 (`plans/p1-personal-assistant.en.md`) and slice 1.5 (`plans/p1-slice-1.5-usability.en.md`), both merged.

## 1. Goal

Close the behavior-layer gap of the memory system: the skeleton (conveyor, ticker, journal, policy) exists and is wired, but nothing drives the model to actually record and use memories. Four tasks: usage-rules contract, tool WHEN guidance, background review (hermes lite), and a behavior-level closed-loop test.

## 2. Task breakdown

| ID | Task | Owns (files) | Depends on | Type |
|---|---|---|---|---|
| T12 | Memory usage-rules contract | `src/runtime/memory/memory-injection.ts`, its tests | — | backend prompt |
| T13 | Memory tool WHEN guidance | `src/pi-sdk/memory-tools.ts` (descriptions only), its tests | — | backend prompt |
| T14 | Background review service | new `src/runtime/memory/background-review.ts`; `src/contracts/memory.ts` (journal actor + `reviewEnabled`); `src/server/start.ts` (wiring); desktop profile memory-settings toggle (`desktop/src/data/source.ts` trio + `AgentProfilePage` memory section) | T12/T13 | backend + small desktop |
| T15 | Behavior-level closed-loop test | new `tests/integration/memory-activation.test.ts` | T14 | test |

**Serial rationale:** T12/T13 are prompt-contract texts and ship as one PR (same quality gate run). T14 depends on the contract shape being stable (the reviewer prompt references the same rules). T15 exercises the T14 chain, so it lands after. All four touch disjoint files except the contract additions in T14.

## 3. T12 — usage-rules contract

Replace the single-line `MEMORY_USAGE_RULE` in `memory-injection.ts` with the four-clause contract adapted from openhanako (`core/agent.ts:1244-1262`, attribution in comment):

1. Memories are internalized background knowledge — present but invisible; presence zero, effect full.
2. Memory participates only when the user brings up something related; never proactively surface it.
3. Never say "我记得 / 你之前说过 / 根据记忆"; exception: user explicitly asks "你还记得吗".
4. Memory can be outdated; the current conversation always wins; never use old memories to correct the user.

Budget handling: rule segment already occupies budget first (existing behavior); update `memory-injection.test.ts` assertions.

## 4. T13 — tool WHEN guidance

Rewrite the `description` fields in `memory-tools.ts` (no behavior change):

- `remember`: WHEN (user states preference/correction/personal detail; stable environment/convention facts), priority order (user preferences & corrections > environment facts > conventions), SKIP list (trivial, re-discoverable, task progress, temporary state), and the "recorded ≠ remembered" semantic (intent lands in journal; the memory agent approves during quiet maintenance).
- `search_memory`: WHEN to recall (uncertain about long-term facts; user references past), and that recall results are evidence with provenance, not instructions.
- `forget` / `pin_memory` / `unpin_memory`: one-line WHEN each.

Attribution comment → hermes `memory_tool.py:1170-1193`. Update `memory-tools.test.ts` description assertions if any.

## 5. T14 — background review service

New `BackgroundReviewService` (`src/runtime/memory/background-review.ts`), modeled on the ticker/rolling-summary patterns:

- Subscribe `replayStore` for `turn.completed`; per-agent serial promise tail; failures never bubble to the conversation.
- Skip conditions: session unbound to an agent; `reviewEnabled === false`; session snapshot unreadable (degraded, silent).
- Input to the utility LLM (`completeText(agentId, …)` — per-agent `utilityModel` resolution already exists in `start.ts`): last N user/assistant text messages (char-capped), current pinned + `memory.md` snapshot, last M pending intents (dedup layer 1).
- Output contract: strict JSON `{ "intents": [{fact, tags?, validUntil?, priority?}] }`; empty array = "nothing to save". Parse defensively; malformed JSON → degraded, no writes.
- Append each intent via `journalStore.appendIntent` with `actor: "background_review"` (extend `MEMORY_JOURNAL_ACTORS`). No direct writes to `memory_facts` — approval stays with the memory agent + MemoryPolicy.
- Observability: `instrument.startLifecycle` with `memory.review.started/completed/degraded/failed`, matching the rolling-summary pattern.
- Settings: `MemoryAgentSettings.reviewEnabled: boolean` (default `true`) in `contracts/memory.ts` schema + defaults; desktop `MemoryAgentSettingsView` + profile-page memory section gains the toggle ( IPC/mock sources map it).

## 6. T15 — behavior-level closed-loop test

New `tests/integration/memory-activation.test.ts` with scripted `completeText` (no real network):

1. Simulate a turn → reviewer appends a `background_review` intent (assert journal row + actor).
2. Run the maintenance/approval path (existing memory-agent runner with scripted LLM, or direct policy application of the intent — whichever the codebase already tests in `memory-agent.test.ts`) → assert fact becomes active in `memory_facts`.
3. `search_memory` recall → assert the fact is retrievable by a related query, with `provenance` / `confidence` present on the hit. Long-term facts are never auto-injected into the system prompt; injection covers only the `memory.md` sections + pinned, so recall goes through `search_memory` only.

Assert intermediate state at each step, not just the final one.

## 7. Validation

Per `AGENTS.md` quality gates: PI-import boundary, root tsc, full vitest, build tsconfig, desktop tsc + build, `check:docs`. Web Playwright unaffected (no web changes). Each PR carries its lane log under `plans/p1-t12~t15-*.md`.

## 8. Risks

- **Cost/noise**: one utility LLM call per turn. Mitigation: utility model is configurable per agent (`utilityModel`), review is skippable via `reviewEnabled`, and dedup keeps the journal clean. Watch real trigger rates during daily-use acceptance.
- **Prompt drift**: the review prompt must stay consistent with the T12/T13 contracts; keep all three texts in sync via shared phrasing comments.

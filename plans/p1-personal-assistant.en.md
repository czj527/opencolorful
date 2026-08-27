# P1: Usable Desktop Personal Assistant — Slice 1 Implementation Plan

**Status: In Progress** | Base: `main` (`9ad0957`)
**Spec (Chinese, authoritative for product decisions):** `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md`
**Upstream:** `docs/positioning-and-roadmap.md` §五 P1 | **Related:** `plans/desktop-parity.md` (D waves, merged into P1)
**Language note:** This plan follows document-governance §8 (class A, English-authoritative). Product-decision wording remains governed by the Chinese spec.

## 1. Goal (user-observable)

A first-time user can, within 5 minutes of launching the desktop app: create their assistant, configure a model provider, pick a working directory, understand tool permissions in plain language, and complete a first streaming conversation. Returning users see the assistant's identity in the UI, can inspect/pin/correct memory, and every failure state offers a readable Chinese message with a concrete next action.

## 2. Capability Survey (verified 2026-08-26 against `src/server/routes/`)

All required backend endpoints already exist; **no new backend endpoints are needed** for this slice:

- `POST /api/agents`, `GET /api/agents/templates` — assistant creation with base-color templates
- `PUT /api/settings/providers` (`{provider, apiKey?}`; key goes to AuthStorage only) — provider setup
- `POST /api/sessions` with full run settings — session creation (D1b consumer)
- `GET/PUT /api/agents/:id/memory/pinned`, `GET/PUT .../memory/settings` — memory daily-use surfaces
- `GET /api/agents`, `GET /api/settings/providers` — first-run detection is derivable client-side (no agents OR no provider with `credentialConfigured`)

Missing pieces this slice must build:

- Native directory picker for Electron (`dialog.showOpenDialog` via preload), replacing the web-oriented `/api/directories/pick` flow in desktop UX
- Onboarding wizard shell + step pages (all UI, consuming the endpoints above)
- Assistant ID-card identity surface (sidebar card → profile page) + sidebar session grouping — data already available, presentation + edit affordances (design input §2a)
- Error-recovery copy pass across onboarding/chat/memory/settings paths

## 2a. Design Input (2026-08-27, author)

Absorbed from the author's Kimi Code web / openhanako usage experience; spec §二补 is authoritative for product wording. Absorb decisions, do not copy.

In this slice:

- **Assistant ID card**: sidebar card (name, base color, real-time status) → click opens profile page (identity / persona / memory). Card form = human-fixed (author-specified); profile-page information architecture = agent-recommends, PR review.
- **Sidebar session grouping**: inspired by Kimi Code's 进行中/已完成, group threads by active (streaming) / recent / archived = agent-recommends.
- **Real-state honesty constraint**: card status is driven only by real runtime state (idle / thinking / tool-running / offline). No fabricated "mood". Aliveness comes from real state and real memory, not performance = human-fixed.

Slice-2 backlog (recorded, not committed):

- Background-task / progress visibility near composer (background bash, background subagents, compaction progress) — needs event-projection design;
- openhanako-style mood / surfing persona states — pending honesty review against the real-state constraint;
- Compaction visibility in the timeline (`/compact` command exists; projection missing).

## 3. Tasks & Dependency Graph

```text
T0 (main agent, serial)  →  T2 (lane B)  →  T1 (lane A) ┐
                          ↘  T3 (lane C) ───────────────┘ (T3 also needs T0)
pg-2: T4 (lane D) ∥ T5 (lane E) ∥ T6 (lane F)  — independent of T0/T2, disjoint files
```

- **T0 — Shared scaffolding (main agent, serial).** `serial_reason`: T1, T3, T4 and T5 all register UI entry points in `desktop/src/App.tsx` / sidebar; the route/state skeleton must land first to keep lanes disjoint. Scope: onboarding route + first-run detection hook (`useFirstRun`: no agents or no credential-configured provider), empty-state entry points, agent-profile page route stub.
- **T1 — Onboarding wizard (lane A).** Depends on T0, T2. Four steps: create assistant (name + base-color template) → configure provider → pick working directory → plain-language permission explainer; lands in first conversation. Onboarding UX and interaction details owned by main agent (UI aesthetics per division of labor); mechanical form wiring may be delegated.
- **T2 — Native directory picker (lane B).** Depends on nothing. `dialog.showOpenDialog` in Electron main, exposed through preload on `desktopApi`; fallback to manual path input outside Electron. IPC path validation stays within existing main-process rules.
- **T3 — D1b full new-session form (lane C).** Depends on T0, T2. Align with web session-new: title / cwd / agent / toolMode / thinking / model / workspace.
- **T4 — Assistant ID card + sidebar grouping (lane D).** Independent. Sidebar: ID-card style assistant card (name, base-color summary, real runtime status per §2a honesty constraint) + thread grouping (active / recent / archived). Owns `Sidebar.tsx` and the new `AgentCard` component; exposes an `onOpenAssistantProfile` entry consumed by T5's profile page (T0 registers the route).
- **T5 — Agent profile page + memory daily-use (lane E).** Independent. New `AgentProfilePage`: identity / base-color display + memory pinned add/remove + memory settings entry (openhanako-style direct editing against real endpoints). Owns the new page and `MemoryPage.tsx` pinned affordances; reached via T4's card entry and T0's route stub.
- **T6 — Error-recovery copy pass (lane F).** Independent. Audit provider-unconfigured, credential-invalid, 409 session-busy, offline/disconnect paths across onboarding/chat/memory/settings; every failure state gets a readable Chinese message + next action. No raw provider error text.

### Briefs

Each task brief follows `docs/development.md` §4 (role / read_first / owns / forbidden / interface / requirements / acceptance / decision_mode / report / docs) and is written into the implementation log below at dispatch time. Parallel dispatches add `parallel_group`, lane file boundaries, read-only shared-interface references, and integration barrier per §2.

### Decision modes (development.md §6)

- Onboarding copy, wizard step order, permission-explainer wording: **human-selects** (agent drafts, author approves in PR review)
- Memory pin/correct affordance UX: **agent-recommends**
- Error copy wording (Chinese, no raw provider errors): **agent-recommends**
- Visual direction (minimal, dual light/dark theme, established 2026-08-21 desktop redesign): **human-fixed**
- ID-card form; real-state-only status, no fabricated mood: **human-fixed** (design input §2a)
- Sidebar session grouping; profile-page information architecture: **agent-recommends**
- New dependencies: none allowed without spec amendment (**human-fixed**, spec §四)

## 4. Quality Gates

Per `AGENTS.md` — every gate run separately before merge. Risk-driven matrix (`development.md` §7):

- T2 touches the IPC boundary → contract/typing checks + real Electron launch acceptance
- T1/T3 UI flows → focused component logic where applicable + real-backend desktop acceptance per `plans/desktop-e2e-test-plan.md` (new cases appended there)
- T6 copy → walkthrough of each failure path with screenshots
- `npm run desktop:build` green per wave

## 5. Acceptance Checklist (mirrors spec §5)

- [ ] Fresh `OPENCOLORFUL_HOME` → first streaming reply within 5 minutes, without reading docs
- [ ] Assistant recalls, in a later session, information confirmed during onboarding (real recall path, not mock)
- [ ] No raw English errors and no silent failures on onboarding/chat/memory/settings paths; every failure offers a next action
- [ ] Author daily-drives the build for ≥ 5 days; issues are logged as slice-2 input
- [ ] `npm run check` green; desktop real-backend manual acceptance recorded in `plans/desktop-e2e-test-plan.md`

## Implementation Log

- 2026-08-27: Author design input absorbed (Kimi Code sidebar grouping, openhanako profile/mood, ID-card assistant surface) → spec §二补 + plan §2a; T0/T4/T5 rescoped; slice-2 backlog recorded, not committed. (PR #16)
- 2026-08-27 T0 (main agent, serial): onboarding route skeleton + `useFirstRun` + empty-state entry + profile route stub.
  - Files: `desktop/src/use-first-run.ts`, `components/OnboardingPage.tsx/.css`, `pages/AgentProfilePage.tsx/.css` (stub), `Titlebar.tsx` (PageId + onboarding/profile hidden routes), `Sidebar.tsx` (`onOpenAssistantProfile` optional prop contract for T4), `App.tsx` (wiring).
  - Convention: new page/component styles live in co-located single-file CSS imported by the component — keeps parallel lanes out of shared `styles.css`.
  - First-run = no agents OR no credential-configured provider; derived from real backend state, no persisted "done" flag; probe failure fails open to `ready`.
  - Gates: `npm run desktop:build` green (tsc + vite); full `npm run check` + CI. Pending: author manual run with fresh `OPENCOLORFUL_HOME` to see auto-entry (dev machines with existing agents/providers never auto-enter).

(filled during execution: dispatches, commits, verification evidence, deviations)

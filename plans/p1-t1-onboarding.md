# P1 T1 — Onboarding Wizard (lane A)

**Status: Done** | Branch: `feat/p1-t1-onboarding` | Parent plan: `plans/p1-personal-assistant.en.md`

Lane-log convention: see `plans/p1-t2-directory-picker.md`. Main agent implemented this lane
(UI aesthetics + interaction are main-agent scope per the division of labor).

## Brief (development.md §4)

- Role: main agent (lane A). Depends on T0 (route skeleton, merged) + T2 (native picker, merged).
- owns: `desktop/src/components/OnboardingPage.tsx/.css`, `desktop/src/data/source.ts` (+`AgentTemplateView`/`CreateAgentInput`, 2 methods), `desktop/src/data/ipc-source.ts` (+`mapAgentView` shared helper), `desktop/src/data/mock-source.ts` (templates fixture, mutable `mockAgents`, `createAgent`), `desktop/src/errors.ts` (+`createAgent` context), `desktop/src/App.tsx` (wiring only).
- decision_mode: onboarding copy / step order / permission wording = **human-selects** (author reviews in PR); provider preset defaults = agent-recommends; visual direction = human-fixed (minimal, dual theme).

## Implementation record

- **Step order**: create assistant → configure provider → working directory → permission explainer → lands in first conversation.
- **Provider is saved at step 2** (earliest honest failure surface for a bad API key); **the assistant is created only at the final step** — quitting mid-wizard leaves no half-created agent.
- Presets (DeepSeek / Moonshot Kimi / custom OpenAI-compatible) prefill baseUrl/model; advanced fields stay editable. API key goes to AuthStorage via `upsertProvider` — never to config files.
- Directory step uses T2's `pickDirectory()` with manual-input fallback (and skip is allowed).
- Permission step is plain-language copy covering: default read-only, confirmed full mode, auditability via logs page, memory visibility/correction via profile page.
- First-run completion: `useFirstRun().refresh()` re-derives state from real backend data (agent now exists + credential configured) — no persisted "done" flag.
- `errors.ts` extended with `createAgent` fallback; wizard errors reuse `toUserError` (T6 module).
- Mock mode: full wizard is exercisable (mock templates + in-memory `createAgent`/`upsertProvider`).

## Verification

- `npm run desktop:build` green (tsc + vite) on the branch.
- Pending: real-backend click-through (fresh `OPENCOLORFUL_HOME`, real API key) — cases in `plans/desktop-e2e-test-plan.md` wave 七.

## Deviations

- Provider presets hardcode three entries in the renderer (no backend preset catalog exists); model IDs remain editable under "高级设置".
- Templates endpoint failure degrades to a single blank template so the wizard never dead-ends.

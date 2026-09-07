# P1 Audit Remediation — Desktop Session Settings Optimistic-Update Rollback (#77)

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-07
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6 table row "Desktop 设置先乐观更新，失败后不回滚" (`desktop/src/App.tsx:510` at audit time) / §10 queue item 4.

## Goal

Session settings changes in the Desktop chat composer (model, thinking level, tool mode) apply optimistically to local state before the server write completes. When the write fails, the UI must not keep displaying a value the server rejected.

## Non-goals

- No change to the optimistic-update UX itself (instant chip feedback stays).
- No redesign of error surfacing (`setChatError` flow unchanged).
- Global preferences page (SettingsModal) is a separate save path, not touched.

## Defect analysis

`changeModel` / `changeThinkingLevel` / `changeToolMode` (existing-session branch) each did:

1. `setSessionSettings(...)` — optimistic local apply;
2. fire-and-forget server write whose `.catch` only showed an error banner.

On failure the local state kept the rejected value while the server (and any reload) held the old one — UI and server truth diverged until the session was reopened. Three call sites shared the same shape.

## Fix

New `rollbackSessionSettings(sessionId)` helper in `App.tsx`: on write failure it re-pulls canonical server state via `source.getSessionSettings(sessionId)` and replaces local state; if the re-pull also fails (e.g. connection lost), the displayed value is left untouched and the error banner remains.

Re-pull (rather than blind rollback to the captured previous value) was chosen deliberately: with rapid consecutive changes (A then B), a blind rollback triggered by A's failure would also wipe B if B succeeded; the server truth converges correctly in both orders.

All three call sites now invoke the rollback in their `.catch` before/alongside `setChatError`. `confirmWorkspace` / `switchToReadOnly` already update local state only on `.then` (server-confirmed), so they were never affected.

## Tests

`desktop/src/settings-rollback.mock.test.tsx` (full App shell + production `MockDataSource` + `overrideSource` Proxy injection; per `desktop-test-conventions.md` this is a DOM-coupled test living in `desktop/src/`):

- ROLLBACK-01 tool mode write rejected → chip converges back to `all` (rejected value does not linger);
- ROLLBACK-02 thinking level rejected → converges back to `high`;
- ROLLBACK-03 model rejected → converges back to `DeepSeek V3.2`;
- ROLLBACK-04 success path keeps the new value, exactly one server call (no rollback jitter);
- ROLLBACK-05 the stable error line (`工具模式更新失败，请重试。`) still renders on failure.

Assertions target the settled state: with a synchronously-rejected write, the optimistic frame and rollback frame merge into one React commit, so the UI never displays the rejected value; the defect shape (rejected value lingering) is what makes the convergence assertions time out.

Discriminating mutation (run then reverted): commenting out the three `rollbackSessionSettings(threadId)` calls fails exactly ROLLBACK-01/02/03/05 (4/5) while the success-path case stays green.

## Verification

```text
desktop unit suite (vitest)                    -> 110/110 (was 105 + 5 new)
npm run check (governance/typecheck/tests/build/web/desktop) -> green
full true-chain desktop e2e suite              -> 29/29
```

## Known limitations

- If the failure is a network partition that also breaks the re-pull, the UI keeps the optimistic value with the error banner; the next successful load reconciles from the server. No retry queue is added — settings writes are idempotent full-field patches and the error banner invites the user to retry.
- The re-pull is unconditional (no request coalescing). Settings changes are user-paced; the extra GET only occurs on the failure path.

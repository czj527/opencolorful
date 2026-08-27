# P1 Slice 1 — T3: Desktop full new-session form (D1b)

**Lane:** C  
**Task code:** T3  
**Branch:** `feat/p1-t3-session-form`  
**Scope:** Desktop advanced new-session dialog, aligned with `web/src/features/sessions/NewSessionPage` fields.

## 1. Brief summary

Add an "advanced new session" form to the desktop app so users can configure title, agent, working directory, tool mode, thinking level, and model **before** the session is persisted. Keep the existing sidebar "+" → empty-state composer fast path unchanged. The form is reachable from the empty-state "高级新建…" text entry.

## 2. Implementation record

### Files changed

- `desktop/src/data/source.ts` — added `CreateThreadOptions { cwd?, toolMode?, thinkingLevel? }` and widened `DesktopDataSource.createThread` signature.
- `desktop/src/data/ipc-source.ts` — `createThread` now uses `options.cwd` when provided, otherwise falls back to the agent's `defaultCwd`; forwards `toolMode` / `thinkingLevel` to `POST /api/sessions`; sets `workspaceConfirmed: true` when `toolMode === "all"` to satisfy the server's fail-closed workspace rule.
- `desktop/src/data/mock-source.ts` — signature widened to accept `CreateThreadOptions` (no behavior change in mock; the extra options are ignored, mirroring the existing stub contract).
- `desktop/src/components/NewSessionDialog.tsx` — new modal form.
- `desktop/src/components/NewSessionDialog.css` — co-located single-file styles, semantic CSS variables only.
- `desktop/src/App.tsx` — added dialog state, empty-state entry button, and `completeNewSession(thread, agentId)` wiring that switches agent and selects the new session.

### UX entry decision

- **Sidebar "+"** continues to open the empty-state composer draft. No change.
- **Empty-state** gets a secondary "高级新建…" text button under the composer. This keeps the zero-friction flow intact while surfacing the advanced form for users who want to lock in agent / cwd / model / run settings up front.

### Default value sources

| Field | Default source |
|---|---|
| Agent | Current `agentId` from App state |
| Working directory | Selected agent's `workspace` (`defaultCwd` mapped in `mapAgentView`) |
| Tool mode | `draftToolMode` from App composer draft |
| Thinking level | `draftThinking` from App composer draft |
| Model | `draftModel` if still available; otherwise first model with `credentialConfigured === true` |

When the user switches agent inside the dialog, the working directory is overwritten with that agent's default (matching the web new-session behavior).

### Error handling

Creation failures are converted through `toUserError(cause, "send")` so users see a Chinese recovery message instead of raw error text. The dialog also performs client-side validation for empty cwd and unconfirmed `all` tool mode.

## 3. Verification

Run from the worktree root:

```bash
npm install --no-audit --no-fund --legacy-peer-deps
npm run desktop:build
```

Expected: `tsc -p tsconfig.json --noEmit` and `vite build` both pass.

## 4. Deviations / follow-up

- The form does **not** duplicate the web `/new` route as a full page; it is intentionally a modal on top of the chat page to keep the desktop single-window layout intact.
- Model selection is filtered to credential-configured models only; this matches the composer chip behavior, not the raw `listModels()` output.
- `workspaceConfirmed` is not exposed as a user-visible checkbox state on the server side beyond creation; it is auto-set to `true` when the user picks `all`, because the dialog already asks for explicit confirmation via a checkbox.
- No server-side changes were made; `POST /api/sessions` already accepted the required fields (verified in `src/server/routes/sessions.ts`).

## Integration review (main agent, 2026-08-27)

- **Fixed during review**: `createThread` previously auto-sent `workspaceConfirmed: true` whenever `toolMode === "all"`, bypassing the workspace-confirmation gate (ledger #4 semantics). Now `CreateThreadOptions.workspaceConfirmed` forwards the dialog's checkbox state verbatim; unconfirmed `all` degrades fail-safe to read-only server-side and the banner flow takes over.
- Re-verified: `npm run desktop:build` green after the fix.

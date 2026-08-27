# P1 T2 — Native Directory Picker (lane B)

**Status: Done** | Branch: `feat/p1-t2-directory-picker` | Parent plan: `plans/p1-personal-assistant.en.md`

Lane-log convention: every P1 lane records its dispatch brief + implementation evidence in its own
`plans/p1-t<N>-*.md` file (keeps parallel lanes out of the shared parent-plan file; satisfies the
document-governance gate). The parent plan's Implementation Log holds pointers only.

## Brief (dispatch contract, development.md §4)

- Role: coder subagent (lane B); main agent reviewed the diff and re-ran gates.
- owns: `desktop/electron/main.cjs`, `desktop/electron/preload.cjs`, `desktop/src/env.d.ts`, new `desktop/src/data/pick-directory.ts`.
- forbidden: git mutations; new dependencies; changing `sandbox`/`contextIsolation`; anything outside owns.
- interface: `desktopShell.pickDirectory(): Promise<string | null>`; user cancel → `null`; only an absolute path string crosses the bridge (never the raw dialog result).
- decision_mode: agent-recommends (mechanical); no product decisions.

## Implementation record

- `main.cjs`: `desktop:pick-directory` handler → `dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })`; canceled/empty → `null`; returns `filePaths[0]` only.
- `preload.cjs`: `pickDirectory()` exposed on `desktopShell`.
- `env.d.ts`: `DesktopShellApi.pickDirectory(): Promise<string | null>`.
- `pick-directory.ts`: capability probe (`window.desktopShell?.pickDirectory`); returns `null` outside Electron → caller falls back to manual path input.

## Verification

- Subagent: `npm run desktop:build` green in worktree.
- Main agent: independent diff review of all 4 files + re-ran `npm run desktop:build` green; removed one dead exported constant during review.
- Deviation: worktree `npm install` hit a pre-existing `ERESOLVE` peer conflict (`@hono/node-ws` vs pinned `@hono/node-server`), bypassed with `--legacy-peer-deps`; unrelated to this change, main checkout unaffected.
- Pending: real-click acceptance together with T1 onboarding integration (cases appended to `plans/desktop-e2e-test-plan.md`).

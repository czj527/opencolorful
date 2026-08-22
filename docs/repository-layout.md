# Repository Layout Direction

> Updated: 2026-08-18

## Current decision

Do not physically move the mature server code during the desktop prototype phase. The existing import boundaries, tests, and Git history are valuable. Introduce the new desktop application as a separate workspace first, then move shared contracts only when a real second consumer exists.

## Near-term layout

```text
opencolorful/
├─ desktop/                 Electron shell and isolated React renderer
├─ web/                     current browser test/operator client
├─ src/                     server, runtime, storage, CLI, contracts
├─ packages/                public plugin protocol/runtime/SDK packages
├─ docs/                    product, architecture, design, repository guides
├─ plans/                   implementation and acceptance records
├─ examples/                complete runnable examples only
├─ scripts/                 repository checks and release utilities
└─ tests/                   backend integration, unit, contract, smoke, E2E
```

## Intended later layout

Move toward `apps/*` only when the desktop renderer begins sharing production code with another app:

```text
apps/
├─ desktop/
├─ web-operator/
└─ server/

packages/
├─ contracts/               stable cross-process schemas
├─ runtime-client/           HTTP/SSE/WS client and projections
├─ ui/                       brand tokens and genuinely shared primitives
├─ plugin-protocol/
├─ plugin-runtime/
├─ plugin-sdk/
└─ plugin-components/
```

Do not create `packages/ui` by copying the current Web components. Extract only after the desktop prototype proves which primitives are truly shared.

## GitHub preparation checklist

- Refresh the root README around the current Phase 14 state and desktop direction.
- Add screenshots and a short architecture map; avoid presenting the old Web UI as the product surface.
- Keep local runtime data, credentials, screenshots from ad-hoc tests, SQLite files, and generated Electron packages ignored.
- Add `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and a pull request template before public contribution opens.
- Document Node/npm versions and Windows/macOS/Linux support explicitly.
- Run secret scanning and inspect `git ls-files` before the first public push.
- Decide which references and design assets may be redistributed; external reference repositories never enter this Git history.
- Use Git LFS only if durable product assets make normal Git history materially heavy.

## Ownership boundaries

- `desktop/`: presentation, local interaction state, renderer adapters, Electron shell.
- `web/`: current browser-facing operational and test client until intentionally retired.
- `src/contracts/`: cross-process vocabulary; no React or Electron types.
- `src/runtime/`: business behavior; no renderer imports.
- `packages/*`: externally consumable APIs with explicit compatibility expectations.

The desktop prototype must not import server implementation modules. When production wiring begins, it should consume the same platform contracts and event envelopes as other clients.

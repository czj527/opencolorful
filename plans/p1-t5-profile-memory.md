# P1 T5: Agent Profile Page + Memory Daily-Use Write Operations

**Lane:** E  
**Task code:** T5  
**Status:** Implemented, verified  
**Spec:** `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md` §二.3 / §二补 / §四  
**Plan:** `plans/p1-personal-assistant.en.md` §3 T5

## 1. Brief

T5 builds the Agent identity/profile page and enables daily-use memory management in the desktop app:

- Expose the missing pinned-memory write endpoints on the server (POST / DELETE).
- Extend `DesktopDataSource` with profile and memory read/write methods.
- Rewrite `AgentProfilePage` as an ID-card style profile with editable name/description, read-only persona display, pinned memory add/remove, and a small memory-settings surface.
- Add pinned add/remove affordances to `MemoryPage`.

### Pinned endpoint gap — freeze exception

The slice plan (`plans/p1-personal-assistant.en.md` §2) assumed that `GET/PUT /api/agents/:id/memory/pinned` already existed. In reality only `GET` existed; `PUT` was never implemented and the storage layer (`PinnedMemoryStore`) already had `add`/`remove`/`listByAgent`. To avoid introducing a new storage abstraction while still delivering the required user-facing "pin/unpin" capability, T5 adds two minimal HTTP routes (`POST` and `DELETE`) that directly call the existing store. No new storage, schema, or pipeline was created. This is a freeze exception justified by the gap between the plan assumption and the actual code state.

## 2. Implementation record

### 2.1 Server — pinned write endpoints

File: `src/server/routes/memory.ts`

- Imported `crypto` and `PinnedMemoryInput`.
- Added local `isRecord` helper.
- Added routes:
  - `POST /api/agents/:id/memory/pinned`
    - Body: `{ content: string }`
    - Validates `content` is a string, non-empty after trim, and ≤ 500 chars; returns `INVALID_INPUT` with Chinese messages on failure.
    - Generates id with `crypto.randomUUID()`.
    - Returns `{ agentId, pinned: <new item> }` with HTTP 201.
  - `DELETE /api/agents/:id/memory/pinned/:pinnedId`
    - Verifies pinned item exists and belongs to the agent; otherwise `NOT_FOUND` with Chinese message.
    - Returns `{ agentId, removed: true }`.

File: `tests/integration/memory-admin-api.test.ts`

- Added `describe("pinned memory 写端点")` with three tests:
  - POST → GET visible → DELETE → GET gone
  - POST empty/too-long content → 400
  - DELETE missing agent / missing pin / ownership mismatch → 404

### 2.2 Desktop data source extension

File: `desktop/src/data/source.ts`

- Added view types:
  - `AgentProfileView`
  - `MemoryAgentSettingsView`
- Added methods to `DesktopDataSource` (all annotated `T5`):
  - `getAgentProfile(agentId): Promise<AgentProfileView>`
  - `updateAgentProfile(agentId, patch: {name?, description?}): Promise<void>`
  - `getMemorySettings(agentId): Promise<MemoryAgentSettingsView>`
  - `updateMemorySettings(agentId, patch: Partial<MemoryAgentSettingsView>): Promise<void>`
  - `addPinnedMemory(agentId, content): Promise<PinnedMemory>`
  - `removePinnedMemory(agentId, pinnedId): Promise<void>`

File: `desktop/src/data/ipc-source.ts`

- Implemented all six methods using existing `request` helper:
  - `getAgentProfile` calls `GET /api/agents/:id` and maps `AgentViewWire` to `AgentProfileView`.
  - `updateAgentProfile` splits name to `PUT /api/agents/:id` and description (persona) to `PUT /api/agents/:id/base-color`.
  - `getMemorySettings` reads `GET /api/agents/:id/memory/settings` and extracts the four exposed fields.
  - `updateMemorySettings` fetches current settings first, merges the patch, and `PUT`s the full object (server requires full schema validation).
  - `addPinnedMemory` / `removePinnedMemory` call the new endpoints.
- Updated `AgentViewWire` to include `identity.createdAt`, `baseColor.personality`, and `baseColor.replyStyle`.

File: `desktop/src/data/mock-source.ts`

- Added in-memory state for `mockProfile`, `mockMemorySettings`, and `mockPinned`.
- Implemented all six methods against that state so the profile page and memory page are fully operable in mock mode.

### 2.3 AgentProfilePage rewrite

Files: `desktop/src/pages/AgentProfilePage.tsx`, `desktop/src/pages/AgentProfilePage.css`

- Props: `{ agent: Agent; source?: DesktopDataSource }`.
- Sections:
  - ID card: large avatar, name, persona description, workspace, creation time (if available), session count.
  - Basic info editor: name + description; calls `updateAgentProfile` and refreshes.
  - Persona display: reply style + personality tags (read-only; full base-color editing is out of scope per task trade-off).
  - Pinned memory list with per-item delete and an add input.
  - Memory settings: enabled toggle + daily run time + min idle minutes.
- All failures surface a Chinese error banner with a retry action.
- If `source` is absent, the page renders read-only with a hint. This keeps the build green because `App.tsx` currently does not pass `source` (see Deviations).

### 2.4 MemoryPage pinned write operations

Files: `desktop/src/pages/MemoryPage.tsx`, `desktop/src/pages/MemoryPage.local.css`

- Added pinned add/remove UI in the existing pinned section.
- Added `addPinned` / `removePinned` handlers that call the new data-source methods and refresh only the pinned slice via `getMemoryData`.
- Added `MemoryPage.local.css` for the new pinned row/delete/add styles without touching `styles.css`.

## 3. Verification

Commands were run individually in the worktree root (`D:\PI-study\.oc-lanes\t5`):

```powershell
npm install --no-audit --no-fund --legacy-peer-deps
```

Result: completed successfully (546 packages added).

```powershell
npm run desktop:build
```

Result: green — `tsc --noEmit` + `vite build` produced the production bundle.

```powershell
npx tsc --noEmit -p tsconfig.json
```

Result: green — root TypeScript check passed.

```powershell
npx vitest run tests/integration/memory-admin-api.test.ts
```

Result: green — 11 tests passed, including the 3 new pinned write tests.

## 4. Deviations and follow-up

### 4.1 `App.tsx` does not pass `source` to `AgentProfilePage`

`desktop/src/App.tsx:570` currently renders:

```tsx
<AgentProfilePage agent={activeAgent} />
```

The task forbids modifying `App.tsx`, so `AgentProfilePage` accepts `source` as optional and falls back to read-only display when it is missing. To make the profile page fully editable in the running app, the main agent integration step is:

```tsx
<AgentProfilePage agent={activeAgent} source={source} />
```

This single-line change is the only remaining wiring needed.

### 4.2 Base-color editing scope

The task allowed skipping full base-color editing if the shape was complex. T5 chose:

- Editable in basic info: `name` and `description` (mapped to `baseColor.persona`).
- Read-only in persona section: `replyStyle` and `personality`.

Full `personality` / `replyStyle` / `innerSetting` editing can be added later without changing the data-source contract.

### 4.3 Dual pinned-management entry points

Both `AgentProfilePage` and `MemoryPage` can add/remove pinned memories. This is intentional per the agent-recommends UX decision: the profile page offers identity-context management, while the memory page offers memory-context management. Both use the same data-source methods and backend endpoints, so state converges on the next refresh.

### 4.4 Files touched

- `src/server/routes/memory.ts`
- `tests/integration/memory-admin-api.test.ts`
- `desktop/src/data/source.ts`
- `desktop/src/data/ipc-source.ts`
- `desktop/src/data/mock-source.ts`
- `desktop/src/pages/AgentProfilePage.tsx`
- `desktop/src/pages/AgentProfilePage.css`
- `desktop/src/pages/MemoryPage.tsx`
- `desktop/src/pages/MemoryPage.local.css`
- `plans/p1-t5-profile-memory.md` (this file)

### 4.5 Risks / not covered

- No new Playwright/desktop E2E tests were added; coverage is unit/integration only.
- `AgentProfilePage` cannot be exercised end-to-end with write operations until `App.tsx` passes `source`.
- Memory settings `updateMemorySettings` always fetches the full settings object before patching; this adds one extra round-trip but keeps schema validation happy.

## 5. Integration & CI investigation (main agent, 2026-08-27)

- Main-agent integration fixes on top of the subagent work: `App.tsx` now passes `source` to `AgentProfilePage`; mock `getMemoryData` returns the mutable `mockPinned` (subagent had left it on the static fixture, so pinned writes were invisible in mock mode).
- Re-verified after fixes: `desktop:build` green, root `tsc --noEmit` green, `memory-admin-api.test.ts` 11/11 green.
- **CI episode**: Browser E2E `phase6` timeline test (turn-2 "发送消息" not visible within 30s) failed 4/4 on this branch while local full suite passed 59/59 and main stayed green. T5's server diff is inert for that test (new pinned POST/DELETE routes are never called by the web E2E; desktop files are not loaded). Per the g0 ledger's "若复现则单独深挖", added failure diagnostics instead of blindly retrying or masking with a bigger timeout: `web/playwright.config.ts` now retains trace + screenshot on failure, and `quality.yml` uploads `web/test-results/` as an artifact on failure.

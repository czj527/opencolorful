# P1 T4: Assistant ID Card + Sidebar Session Grouping

**Status:** Done | Lane: D | Task: T4
**Spec:** `docs/superpowers/specs/2026-08-26-p1-personal-assistant-slice.md` §二补
**Parent plan:** `plans/p1-personal-assistant.en.md` §3 T4

---

## 1. Brief

### Owns
- `desktop/src/components/AgentCard.tsx` + `AgentCard.css` — sidebar identity card.
- `desktop/src/components/Sidebar.tsx` + `Sidebar.css` — integration of the card and thread grouping.
- `plans/p1-t4-idcard-sidebar.md` — this A-class plan.

### Forbidden
- No changes to `App.tsx`, `styles.css`, `data/*`, or unrelated files.
- No new runtime dependencies.
- No git commits/pushes.

### Interface
- `SidebarProps` extended with optional `assistantStatus?: AssistantStatus`.
- `AssistantStatus = { label: string; tone: "ok" | "busy" | "offline" }`.
- `onOpenAssistantProfile?: () => void` (pre-declared by T0) is consumed by the ID card click.
- The status line is rendered **only** when `assistantStatus` is provided; otherwise it is omitted to satisfy the real-state honesty constraint.

### Requirements
- ID-card style assistant surface at the top of the sidebar: large circular avatar (initial + `agent.color`), name, description, optional real runtime status.
- Card click triggers `onOpenAssistantProfile`.
- Preserve agent switching (chevron opens agent menu) and sidebar collapse.
- Group non-archived threads into "进行中" (`status === "active"`) and "最近" (all other non-archived statuses); do not render an empty "进行中" group.
- Keep the existing "已归档" collapsible section unchanged.

### Decision mode
- ID-card form and real-state-only status: **human-fixed** per spec §二补.
- Sidebar session grouping (active / recent / archived): **agent-recommends**.

---

## 2. Implementation Record

### 2.1 Agent ID card (`AgentCard.tsx` / `AgentCard.css`)
- New co-located component following the `OnboardingPage` single-file CSS convention.
- Card layout: top-right tool row (chevron + collapse), then clickable body (avatar + text column).
- Status row is conditionally rendered. Tone maps to a colored dot:
  - `ok` → `--ok`
  - `busy` → `--warn` with pulse animation
  - `offline` → `--text-3`
- Uses existing semantic CSS variables only; no hardcoded theme colors except avatar text (`#fff` for contrast on arbitrary agent colors).

### 2.2 Sidebar integration (`Sidebar.tsx`)
- Imported `AgentCard` and `AssistantStatus`.
- Added `assistantStatus?: AssistantStatus` to `SidebarProps`.
- Replaced the old `.agent-button` area with `AgentCard`.
- Empty-agent state retained with the same copy ("无 Agent / 请在运维面创建") and styled via shared `agent-card` classes; collapse button still available.
- Agent menu dropdown logic preserved; still rendered by `Sidebar` and positioned relative to `.sidebar-head`.
- Added `ThreadGroup` helper component to render a titled group of threads; returns `null` when empty.
- Threads split into `activeThreads` and `recentThreads`; both passed to `ThreadGroup` inside the existing "会话" section.

### 2.3 Sidebar styling (`Sidebar.css`)
- Added group header styling aligned with `.sidebar-section > header`.
- Added empty-card cursor/hover overrides so the non-clickable empty state does not look interactive.

### 2.4 Mock data compatibility
- `mock-data.ts` already defines `Thread.status: "active" | "waiting" | "quiet"` and `initialThreads` contains all three statuses, so the active/recent split is visible in mock mode without data changes.

---

## 3. Verification

Commands run from `D:\PI-study\.oc-lanes\t4`:

```powershell
npm install --no-audit --no-fund --legacy-peer-deps
npm run desktop:build
```

Result:

```text
> opencolorful@0.1.0 desktop:build
> npm run build --workspace=@opencolorful/desktop


> @opencolorful/desktop@0.1.0 build
> tsc -p tsconfig.json --noEmit && vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 1847 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                        0.50 kB │ gzip:  0.31 kB
 dist/assets/index-BbRxImSq.css        36.91 kB │ gzip:  6.79 kB
 dist/assets/projector-CwVOI9lp.js      6.19 kB │ gzip:  2.28 kB
 dist/assets/mock-source-x1KPlI4X.js    8.03 kB │ gzip:  3.36 kB
 dist/assets/ipc-source-D5g5FzDe.js    14.86 kB │ gzip:  5.08 kB
 dist/assets/index-J_0a5FUC.js        289.08 kB │ gzip: 90.49 kB
✓ built in 2.28s
```

Exit code: 0.

---

## 4. Deviations

- None at this time.

---

## 5. Integration Note for Main Agent

To light up the status line, `App.tsx` needs to pass `assistantStatus` into `<Sidebar />`, e.g.:

```tsx
<Sidebar
  ...
  assistantStatus={{ label: "空闲", tone: "ok" }}
/>
```

The card surface and profile navigation are already wired through the existing `onOpenAssistantProfile={() => setPage("profile")}` prop.

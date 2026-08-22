# OpenColorful Desktop Design

> Status: desktop visual and interaction baseline (v2, minimal)
> Updated: 2026-08-20

v2 supersedes the v1 "Window Desk" direction (archived in
[design-window-desk.md](design-window-desk.md)). Rationale: at the current early
stage the desktop prototype should demonstrate **interaction and function**, not
a distinctive visual identity. v2 is a neutral, minimal workbench with light and
dark themes; the watercolor identity may return later as a theme on top of the
same token system.

## 1. Principles

- **Function first.** Every surface answers a real platform concept (sessions,
  events, approvals, memory, logs, Subagents, plugins). No decorative artwork.
- **Two layers in the conversation.** Normal messages stay continuously
  readable; thinking, tool calls, file changes, plans, approvals, Subagent and
  memory recalls render as collapsed event rows with status, meta and one clear
  disclosure affordance.
- **On-demand operational surfaces.** The right dock (diff review, terminal)
  appears only when opened; never inject status cards into the conversation.
- **Calm chrome.** 1px hairline borders, 6px radius, no gradients or decorative
  shadows; overlays (modal, menus) are the only elevated surfaces.

## 2. Theme system

Semantic CSS variables in `:root`; `:root[data-theme="dark"]` overrides only the
color values. Structure (spacing, radius, typography) is theme-independent.

- Light: white canvas, gray text hierarchy, `--accent` blue; semantic `--ok` /
  `--warn` / `--err` / `--violet` for event kinds and states.
- Dark: near-black layered surfaces with the same accent family, slightly
  brightened for contrast.
- `useTheme` (`src/theme.ts`) drives `light` / `dark` / `system`, persists to
  `localStorage`, sets `color-scheme`, and listens to OS changes while in
  `system` mode. Titlebar toggles light/dark directly; Settings → 通用 offers
  the three-way choice. Electron `backgroundColor` follows `nativeTheme`.

## 3. Layout

```text
titlebar:  brand · page tabs (对话/记忆/日志) · runtime state · theme · window controls
sidebar:   agent switcher · session list · scheduled work · settings entry
center:    chat header · scrollable timeline (max 740px) · composer
right:     dock (变更审查 / 终端), hidden until opened
settings:  centered modal with grouped category nav
```

- The sidebar collapses to zero width; restore lives in the titlebar.
- The dock keeps exactly one tool active; opening it never replaces the
  conversation.
- Settings is an application-level modal (Esc / backdrop closes), not a
  workspace tab.

## 4. Conversation events

Event kinds: `thinking`, `tool`, `file`, `plan`, `approval`, `subagent`,
`memory`. A collapsed row shows icon + kind label + one-line summary + mono meta
(duration, counts, model). Expanding reveals operational evidence (tool call
table, changed-file list, plan steps, Subagent result, recalled memory entries),
not a copy of the agent's prose. Pending approvals carry inline 允许/拒绝
actions and record the decision in place.

## 5. Interaction

- Enter sends, Shift+Enter newline, IME composition never submits.
- The composer exposes model / thinking level / tool mode as clickable chips
  (cycle on click) and a workspace chip; send becomes stop while streaming.
- Replies stream in; stopping marks the message 已停止 instead of deleting it.
- New conversations start from a sparse state: agent picker + composer only; the
  first message creates the thread (mirrors the server rule: no session row
  before the first prompt).
- `prefers-reduced-motion` disables animation; every icon-only control has an
  accessible label.

## 6. Plugin UI contribution model (unchanged from v1)

The host owns navigation, layout, permissions and lifecycle. Plugins contribute
bounded content through three contracts only:

| Contribution | Placement | Visibility rule |
| --- | --- | --- |
| `workspace.page` | titlebar page tabs | enabled and explicitly opened or pinned |
| `workbench.panel` | right dock body | opened by task, command or user action |
| `settings.section` | settings modal | plugin loaded, enabled, declares config UI |

Installing a plugin never creates permanent navigation by itself.

## 7. Backend isolation (unchanged from v1)

Renderer components consume a `DesktopDataSource`-style interface; the prototype
uses local mock data. The Electron preload exposes only window-shell operations
— no runtime credentials, filesystem or Agent APIs reach the renderer. The
event-kind mapping table in v1 §9 remains the contract for wiring real backend
events to the event rows.

## 8. Acceptance viewports

- primary: 1440×900
- compact: 1280×800
- minimum shell: 1024×720

Both light and dark themes must hold at these sizes: no overlap, no horizontal
overflow, no clipped controls.

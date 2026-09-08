# P1 Audit Remediation — Mock Entry Point Removal / Demo Labeling (#81)

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-08
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §7.5 "Diff、Terminal、Approval 仍有 Mock 入口" / §10 queue item 10 (final item).

## Goal

In the real IPC mode the product must not present interactions that only change local state or render hardcoded demo content — users must not be led to believe they reviewed a real diff, ran a real terminal, or completed a real approval.

## Non-goals

- No real diff/terminal/approval backend is added here; these capabilities return as new panels wired to real data sources when implemented (the demo assets in `mock-data.ts` are kept for the mock demo session and future reuse).
- The Web client is out of scope (ops/protocol surface, G1).
- Subagent Dock (real, wired) is untouched.

## Defect analysis

Three entry points remained reachable in the real IPC mode:

1. **Diff panel**: rendered a hardcoded `dockFiles` list with no demo marker at all.
2. **Terminal panel**: fixed script text (had a small `mock` chip, but reachable as a first-class tab).
3. **Approval buttons**: `event.approval` rows rendered 允许一次/拒绝 buttons that only flipped component-local state — no server round-trip.

Data-source audit: the real projector (`src/data/projector.ts`) emits only `memory/plan/status/thinking/tool` event kinds — `file` and `approval` kinds (and therefore the fake diff jump and the approval buttons) are only reachable inside the mock demo session. The Dock, however, is a static component whose diff/terminal tabs rendered unconditionally in both modes.

## Fix (audit's "hide the entry" option, applied to the product frontend)

- `Dock.tsx`: `DockTool` narrowed to `"subagent"`; the 变更审查/终端 toggle buttons and both static panels removed; the Dock now renders only the real SubagentDock. `dockFiles`/`DockFile` stay in `mock-data.ts` (demo session assets, no UI references).
- `ChatView.tsx`: the file-event detail no longer offers the 在右侧审查 jump (its only target was the removed demo panel); the approval button row gains an explicit `演示` chip declaring the local-only state machine.
- `App.tsx`: `onOpenDiff` becomes a no-op stable callback (kept so the EventDetail contract survives until the real diff panel returns).

## Tests

`desktop/src/mock-entry-gate.mock.test.tsx` (3 cases): the chat header exposes exactly one dock toggle (Subagent) — 变更审查/终端 buttons absent; the Subagent dock opens through the sole entry with its functionality intact and no demo tabs inside; the approval actions row carries the `演示` label.

Discriminating mutation (run then reverted): re-adding the 变更审查/终端 toggle buttons fails MOCK-GATE-01 exactly.

## Verification

```text
desktop unit suite (vitest)                    -> 123/123 (was 120 + 3 new)
npm run check                                  -> green
full true-chain desktop e2e suite              -> 29/29
```

## Known limitations

- The approval `演示` chip labels the interaction, but the mock demo session itself is only reachable in mock mode; real sessions can never render approval rows (projector never emits the kind). When real approval flow lands (sandbox/policy integration), the chip and the local state machine must be replaced by the server round-trip.
- Diff/terminal re-entry should follow the A-wave planning (real data sources + panels), not by restoring the removed static panels.

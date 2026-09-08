# P1 Audit Remediation — Web SSE Event Protocol Alignment (#79)

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-07
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §7.2 "Web 事件协议未完整收口" / §10 queue item 8.

## Goal

The Web client acts as the protocol/ops acceptance surface (G1: Desktop is the product frontend, Web is frozen as protocol/test client). Its SSE client must declare every event type the server contract defines, so protocol verification over the web channel sees the same event stream as the server and Desktop emit.

## Non-goals

- No behavior change in how web renders these events (web does not project todos or branch trees; the events are now *received and dispatched* instead of silently dropped — consumption depth is out of scope for the protocol client).
- No server changes.

## Defect analysis

The server sends named SSE events (`event: <type>`); a client only receives types it has registered an `addEventListener` for. `web/src/lib/sse-client.ts` `KNOWN_EVENT_TYPES` was missing 6 types that exist in the server contract `src/contracts/events.ts` `EVENT_TYPES`:

- `turn.failed` / `turn.cancelled` / `turn.interrupted` (turn terminal states)
- `session.branch.switched` / `session.branches.changed` (Wave B branch events)
- `todo.updated` (Wave B durable todo)

Any of these arriving on a web session subscription was silently dropped — a cross-client contract gap that also weakens the web channel's value as a protocol acceptance surface.

## Fix

`KNOWN_EVENT_TYPES` now contains all 38 contract types (order aligned with the server list) plus the `reset` transport special case (documented: reset is sent as a standalone `event: reset` frame outside the contract list).

A contract-alignment regression (`web/src/lib/sse-contract.test.ts`) locks both sides with file-level extraction (the web client cannot import Node-side contract sources): each side's array is regex-extracted from its source file and asserted set-equal (missing = fail, extra = fail with `reset` whitelisted), plus a tautology guard asserting the Wave B types exist in the server contract so extraction breakage cannot silently pass. Repo root is located by walking up from `process.cwd()` until both source files exist (npm workspace test cwd is `web/`; `import.meta.url` is not file-scheme under vitest transforms).

## Tests

`web/src/lib/sse-contract.test.ts` (3 cases): no contract type missing from web; no web type outside the contract (`reset` excepted); Wave B types present in the contract (extraction sanity).

Discriminating mutation (run then reverted): removing `todo.updated` from the web list fails exactly the "不漏" case with a message naming the missing type.

## Verification

```text
web unit suite (vitest)                        -> 431/431 (was 428 + 3 new)
npm run check (incl. web:test + web:build)     -> green
full true-chain desktop e2e suite              -> 29/29
```

## Known limitations

- The alignment test extracts string literals from source files rather than importing a shared contract module. Server-side sources are Node-only today; if a shared ESM contract package emerges later, the test should switch to direct import for stronger coupling.
- Web still does not *render* todo/branch state; per G1 this is intentional for the ops client.

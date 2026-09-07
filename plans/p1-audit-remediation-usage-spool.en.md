# P1 Audit Remediation: Usage Durable Spool / Reconciliation

Status: COMPLETE (2026-09-07)
Audit source: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §6 row 3 / §10 follow-up #2
PR: #75 (branch `audit-p1-75-usage-spool`)

## Goal

Close audit finding "Usage 写入失败可能只吞错或告警，没有 durable spool/reconciliation"
(`src/runtime/usage-recorder.ts:145`、`src/runtime/subagents/runtime/usage-ingestion.ts:99`),
so that usage accounting for every source survives transient write failures.

## Non-Goals

- No change to the usage_records schema shape or query APIs (UsageStore.record semantics
  and dedupe keys are untouched).
- No cost accounting (stays out of scope per the A8 wave decision).
- No retry loop with backoff policy tuning — a single retry schedule (failure-triggered,
  30s) plus startup reconciliation is the whole mechanism.

## Defect Analysis (source-verified)

Three ingestion sites write `usage_records` after model calls:

1. **Main session** (`UsageRecorder.handleEvent`, turn terminal events): `usageStore.record`
   was completely unguarded — a throw would propagate into the `EventReplayStore` subscriber
   dispatch loop (replay-store swallows it there, but other subscribers in the same dispatch
   already ran and usage is lost).
2. **Utility calls** (`runUtilityCallWithUsage`): `try { record } catch {}` — silent loss on
   both success and failure paths.
3. **Subagent runs** (`createSubagentUsageIngestion`): `try { record } catch { instrument.warn }`
   — warn-only loss.

All three violate the A8 promise "所有来源用量可查": a transient SQLite write failure
(lock contention, migration window, disk hiccup) permanently loses the row.

## Fix

### v16 migration (`src/storage/migrations.ts`)

New `usage_pending` table (id, dedupe_key, payload, reason, attempts, last_error,
enqueued_at, updated_at) + index on enqueued_at. Rows carry only accounting numbers and
association dimensions — same sensitivity class as `usage_records`, no message bodies,
no credentials.

### `UsageSpool` (`src/storage/usage-spool.ts`)

- `recordWithSpool(input)`: try `usageStore.record(input)`; on failure serialize the raw
  `UsageRecordInput` (JSON) into `usage_pending` and schedule a delayed retry. If the
  spool itself fails (database fully unwritable), emit `instrument.error` and swallow —
  accounting loss stops there, never propagates to callers.
- `reconcile()`: replay pending rows oldest-first through `usageStore.record` (dedupe-key
  idempotent, aligned with the UNIQUE constraint), delete on success, on per-row failure
  increment `attempts` and keep the row (poison rows don't block the queue head).
  Re-entrancy guarded. Callers: composition root once at startup + failure-triggered
  retry timer (unref'd, serialized).

### Wiring (all optional-injection, old behavior preserved when absent)

- `UsageRecorder` gains a 5th `spool?: UsageSpool` ctor param; main-session record goes
  through `recordWithSpool` (falls back to swallow-only when absent).
- `runUtilityCallWithUsage` gains a 4th `spool?` param for both success and failure records.
- `createSubagentUsageIngestion` deps gain `spool?`.
- `start.ts`: one `UsageSpool` instance created after the database opens, `reconcile()`
  at boot, injected into `UsageRecorder`, `completeText`'s utility calls, and
  `buildSubagentComposition` (new optional `usageSpool` input).

## Tests

New `tests/integration/usage-spool.test.ts` (3 cases):

1. All three ingestion points with an injected failing `UsageStore`: publish/reject
   never propagates, 3 pending rows captured, `reconcile()` with a healthy store replays
   all 3 rows with correct source/status/totals, repeat reconcile is a no-op.
2. Poison row (corrupt JSON) doesn't block the queue: the good row replays, the poison
   row stays with `attempts=1`.
3. Restart reconciliation: rows left by a "previous process" (disposed spool) are
   recovered by a fresh spool's startup reconcile.

New `tests/integration/session-migration-v16-usage-spool.test.ts` (3 cases): fresh
database reaches v16 with the exact column set; reopening is idempotent; end-to-end
enqueue → reconcile round-trip.

Discriminating power verified empirically: reverting `recordWithSpool` to the old
swallow-on-failure behavior makes 2 of 3 spool tests fail; restored, 3/3 pass.

Existing tests updated for the version bump (they pinned the literal schema version):

- `tests/integration/session-migration-v15.test.ts`: `CURRENT_SCHEMA_VERSION === 15` →
  `>= 15` (v16 stacks on top; the v15 table-structure facts stay asserted).
- `tests/unit/storage/migrations-recovery.test.ts`: 7 `readVersion(...) === 15` →
  `=== CURRENT_SCHEMA_VERSION` (recovery means "reaches current", not "reaches 15").

## Verification

| Command | Result |
|---|---|
| `npx vitest run tests/integration/usage-spool.test.ts` | 3/3 |
| same, spool reverted to swallow | 2/3 failed (discriminating) |
| `npx vitest run tests/integration/session-migration-v16-usage-spool.test.ts` | 3/3 |
| existing usage tests (`usage-ingestion` / `usage-store-v14` / `usage-api`) | 49/49 |
| `tests/unit/storage/migrations-recovery.test.ts` + `session-migration-v15.test.ts` | 11/11 |
| full root suite (`npx vitest run`) | 2334 passed, 0 failed |
| `npm run check` | all steps passed (exit 0) |
| full desktop e2e true-chain | 29/29 passed |

## Exit Criteria Met

- All three ingestion sites route through the durable spool; no silent accounting loss
  on transient write failure; startup reconciliation recovers pre-crash rows.
- spool payload sensitivity equals usage_records (no bodies, no credentials).
- No secrets, no real provider network in tests (injected failures + faux ids only).

## Known Deviations

- If the database is entirely unwritable (spool insert also fails), the row is
  unrecoverable by design — there is no more-durable local sink than the metadata
  database itself; the loss is now loudly instrumented (`usage.spool.enqueue_failed`).
- Poison rows are retained indefinitely (attempts counter only); there is no max-attempt
  quarantine. Volume is bounded by failure frequency; reconcile runs on each new enqueue.

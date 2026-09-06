# P1 Audit Remediation: Migration Recovery for v13/v14 Table Rebuilds

**Status:** Implemented, awaiting main-Agent review (Lane ③, 2026-09-06)
**Date:** 2026-09-06
**Audit source:** [`docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md`](../docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md) §5 P0-2
**Baseline:** `main` at `15036b7`, branch `p1-audit-fix-migration-recovery`

## 1. Goal and non-goals

**Goal:** Make the SQLite metadata migration chain (v1–v15, `CURRENT_SCHEMA_VERSION = 15`) fully atomic per version step and self-recovering after an interrupted run, so that a process kill during any migration can never leave a database that fails to open on next launch. The audited breakage: v13/v14 table rebuilds executed as multi-statement autocommit `exec` with the version bump last; an interruption left temp tables (`memory_journal_v13` / `usage_records_v14`) behind and the retry crashed with `table ... already exists`.

**Non-goals:**

- No change to migration semantics: preserved row data, dedupe/backfill rules, CHECK constraint contents, and final schema objects are byte-identical to the previous implementation (verified by a whitespace-stripped diff review; see §8).
- No new schema version, no new tables/columns/indexes.
- No repair tooling beyond automatic recovery on open (`applyMigrations` via `openMetadataDatabase`).
- Out of scope: migration steps older than v1–v15 (none exist), PI JSONL session data (SQLite never stores message bodies).

## 2. Changed files

| File | Change |
|---|---|
| `src/storage/migrations.ts` | (a) v13/v14 rebuilds wrapped in a single transaction including the version UPDATE; (b) temp-table self-heal before the rebuild; (c) exported single-step functions `migrateTo13` / `migrateTo14` with a test-only fault hook; (d) all remaining version steps (bootstrap, v2–v8, v10, v11, v15) wrapped in transactions; (e) ALTER dedup added to v2/v3/v4/v7 (the v9/v12/v15 pattern); (f) `tableExists` helper. |
| `tests/unit/storage/migrations-recovery.test.ts` | New fault-injection regression suite, scenarios A/A2/B/C/D/D-mirror/E (7 tests). |
| `plans/p1-audit-remediation-migration-recovery.en.md` | This record. |

## 3. v13/v14 recovery contract (the P0-2 fix)

Each rebuild step is now an exported function (`migrateTo13`, `migrateTo14`) with this contract:

1. **Atomicity.** Create-temp → copy → drop-old → rename → recreate-indexes → `UPDATE schema_version` all execute inside one `database.transaction(...)`. better-sqlite3 rolls back and rethrows on any error. SQLite DDL is transactional, so no statement escapes.
2. **Temp-table self-heal.** Before `CREATE TABLE <tmp>`:
   - if the real table is missing and the temp table exists (old code interrupted between `DROP TABLE` and `RENAME`): `ALTER TABLE <tmp> RENAME TO <real>` first — the temp table holds the only full copy of user data, discarding it would be data loss — then run the standard rebuild;
   - otherwise `DROP TABLE IF EXISTS <tmp>` (the audited leftover state; the real table is authoritative, the partial temp copy is discarded, not merged).
3. **Recovery on retry.** With atomicity + self-heal, any previously interrupted state converges: next `applyMigrations` either re-runs the step cleanly (nothing committed) or the version was already advanced (step skipped).

**No PRAGMA writes inside migration steps.** Only `PRAGMA table_info(...)` reads occur inside steps (transaction-safe). `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000` are set in `openMetadataDatabase` **before** `applyMigrations` and remain outside all transactions — no relocation was needed.

## 4. v1–v15 atomicity / idempotency audit (full inventory)

| Step | Content (summary) | Before fix | Action taken | Rationale |
|---|---|---|---|---|
| bootstrap (v1) | `schema_version`/`sessions`/index + version seed | Idempotent (`IF NOT EXISTS` + empty-check insert) but multi-write without transaction | Wrapped in transaction | Uniform pattern; makes the seed atomic |
| v2 | 3× `ALTER TABLE sessions ADD COLUMN` | Unconditional ALTERs, no transaction, no dedup → interrupted re-run fails `duplicate column` | Transaction + `PRAGMA table_info` dedup | Same pattern as v9/v12/v15; final schema identical |
| v3 | 1× ALTER (`thinking_level`) | Same defect class | Transaction + dedup | Same |
| v4 | 1× ALTER (`agent_id`) | Same defect class | Transaction + dedup | Same |
| v5 | `usage_records` v1 + index | Idempotent CREATEs, version bump separate | Transaction | Atomicity |
| v6 | 11 tables + 2 FTS5 + 6 triggers + indexes | Idempotent CREATEs, version bump separate | Transaction | Atomicity; FTS5/trigger DDL is transactional |
| v7 | `memory_mutation_proposals` + indexes + `ALTER memory_journal ADD priority` | ALTER unconditional, no transaction | Transaction + dedup | Same as v2–v4 |
| v8 | observability tables + FTS backfill (`INSERT … SELECT`) + `observability_state` seed | FTS backfill is non-idempotent on its own; version bump separate | Transaction | Atomicity guarantees a retry never double-backfills the FTS index |
| v9 | `audit_events.event_name` | Already transaction + ALTER dedup | **Unchanged** | Already conforms |
| v10 | plugin tables | Idempotent CREATEs | Transaction | Atomicity |
| v11 | skill tables | Idempotent CREATEs | Transaction | Atomicity |
| v12 | subagent tables + observability columns | Already transaction + dedup | **Unchanged** | Already conforms |
| v13 | `memory_journal` rebuild (`actor` CHECK + `background_review`) | **P0-2**: no transaction, temp table never cleaned, version last | Extracted to `migrateTo13` per §3 | Core fix |
| v14 | `usage_records` rebuild (source/role/status/`dedupe_key`) | **P0-2**: same defect class | Extracted to `migrateTo14` per §3 | Core fix |
| v15 | 4× `ALTER sessions` (deduped) + `session_todos` | Dedup present; `session_todos` already `CREATE TABLE IF NOT EXISTS`; version bump separate | Transaction (dedup unchanged) | Atomicity; a leftover half-built `session_todos` is absorbed idempotently |

**CREATE TABLE without `IF NOT EXISTS` inventory:** only the rebuild temp tables (`memory_journal_v13`, `usage_records_v14`) intentionally omit it — they are now preceded by the §3 self-heal, which is the correct form of "判重" for rebuilds (blind `IF NOT EXISTS` on a temp table would reuse a stale/partial copy). Every durable table across v1–v15 uses `IF NOT EXISTS`.

## 5. Fault-injection regression coverage

`tests/unit/storage/migrations-recovery.test.ts` — downgrade-injection method matches the audit's (migrate a fresh DB to current version → rewind `schema_version` → hand-craft leftovers → re-migrate):

| Scenario | Setup | Assertion |
|---|---|---|
| A | v12 + leftover `memory_journal_v13` (with a decoy row) | Migration succeeds, no temp residue, version 15, decoy not merged, table usable with the new `actor` value |
| A2 | Old-table-dropped state (data only in temp table) | Temp table renamed back, data preserved through the rebuild |
| B | v13 + leftover `usage_records_v14` | Same as A for `usage_records` |
| C | v14 + leftover `session_todos` | Migration succeeds, `IF NOT EXISTS` absorbs the half-built table without data loss |
| D | Real v12-shaped DB, fault injected inside `migrateTo13` after all rebuild SQL, before version bump | Version stays 12, temp table gone, old `actor` CHECK restored (insert with `background_review` rejected), legacy row intact; re-running `applyMigrations` reaches 15 and the new CHECK works |
| D-mirror | Same via `migrateTo14` on v13 | Version stays 13, v13 shape restored (`source` column absent), row intact; re-run reaches 15 with `main/primary/completed` backfill |
| E | Legacy rows in `memory_journal` + `usage_records`, both leftover temp tables present | All 11 journal columns and all v13-era usage columns preserved bit-for-bit through the recovery rebuilds; decoys discarded |

**Scenario D injection method (chosen: exported single-step functions + optional test-fault parameter).** `migrateTo13/14` accept `testFault?: { afterRebuild?: () => void }`, invoked after the rebuild SQL and before the version UPDATE; production call sites pass nothing. Rejected alternatives: a module-global hook object (mutable global state, cross-test pollution risk), shadowing `database.exec` on the instance (couples the test to SQL string content and risks interfering with better-sqlite3 internals), and ESM namespace spying (export bindings are not reliably patchable under ESM). The chosen point covers the most dangerous interruption window — the old table is already dropped/renamed — proving full-statement rollback rather than merely "nothing happened yet".

## 6. Verification

| Command | Result |
|---|---|
| `npx vitest run tests/unit/storage/migrations-recovery.test.ts` | 1 file / **7 passed**, exit 0 |
| `npx vitest run tests/unit/storage/` | 1 file / 7 passed, exit 0 |
| `npx vitest run` (root, full) | **194 files / 2282 tests passed**, exit 0 |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run check` (full gate: docs, PI/plugin import boundaries, builds, typecheck, tests, web, desktop) | exit 0 |

Note: the first full `npx vitest run` on this fresh worktree had 59 failing files with `ERR_MODULE_NOT_FOUND: @opencolorful/plugin-protocol/dist/index.js` — the workspace packages had not been built after `npm ci`. After `npm run build:protocol && npm run build:sdk` the same command passed 194/2282. This is an environment/sequencing artifact, unrelated to the migration change (`npm run check` builds before testing, so CI is unaffected).

## 7. Exit criteria

- All audited leftover states (temp tables present, version not advanced; old table dropped) recover automatically on next open — scenarios A/A2/B/C prove it.
- An exception mid-rebuild cannot corrupt state or strand the version — scenario D/D-mirror prove it.
- User data survives recovery — scenario E proves it.
- Full quality gate green on `p1-audit-fix-migration-recovery`.

## 8. Known deviations and risks

- **Rename-back self-heal (scenario A2) goes one step beyond the audited leftover states.** The audit only demonstrated "temp table exists + `CREATE` fails". Handling the "old table dropped, data only in temp" window is deliberate: dropping the temp table in that state would destroy the only copy of user data. It adds two guarded statements and is covered by A2.
- **ALTER dedup added to v2/v3/v4/v7.** These predate the v9 pattern. Transaction wrapping alone would prevent *new* partial states, but a database damaged by the *old* code would still die on `duplicate column`. Dedup is strictly recovery-enhancing; column definitions and final schema are identical.
- **FTS backfill in v8 remains a plain `INSERT … SELECT`** rather than FTS5 `rebuild`. Inside the transaction it is retry-safe (rolled back wholesale on interruption). A damaged-by-old-code v8 state is not specially healed; no such field report exists and healing it would require guessing at index state. Accepted residual risk, recorded here.
- **Schema-semantic equality verified by diff discipline, not tooling.** The rewrite re-indented transaction-wrapped blocks; correctness was checked with a whitespace-stripped sorted-line diff of old vs. new `migrations.ts` (only wrapper/dedup/self-heal/comment lines differ) plus `git diff -w`. One transcription error made during the rewrite (v6 `memory_facts_ad` / `memory_facts_au` FTS delete-command table name momentarily written as `memory_events_fts` instead of the original `memory_facts_fts`) was caught exactly this way and reverted to the original text before any test run; the original triggers contain no anomaly.
- Tests use isolated `os.tmpdir()` homes and never touch a real Provider network, per repo red lines.

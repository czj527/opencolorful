# P1 Audit Remediation: verify-plugin-imports entry-check fix and executable regression test

**Status: Completed in lane worktree `wt-plugin-gate` (2026-09-06), pending main-agent review**
**Lane**: branch `p1-audit-fix-plugin-import-gate`, base main `15036b7`
**Audit source**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §7.1 ("Plugin import 检查是假通过")

## Goal

- Fix the confirmed governance-gate defect: the CLI entry check in `scripts/verify-plugin-imports.mjs` compared a disk path against a `file://` URL string and was therefore always false, so invoking `node scripts/verify-plugin-imports.mjs` never executed the scan and the `check:plugin-imports` gate was a permanent no-op (always exit 0, no output).
- Add an executable regression test that proves the gate really executes (violation fixture → exit 1 with violation descriptions; clean fixture → exit 0 with OK) and covers the three violation rules of `findPluginImportViolations` directly.

## Non-goals

- No change to the rule semantics or the exported signature of `findPluginImportViolations` (`(projectRoot: string) => string[]`, unchanged).
- No changes to `package.json`, `CHANGELOG.md`, `docs/project-status.md`, existing `plans/*.md`, or `docs/superpowers/specs/*` (main agent consolidates those).
- No remediation of plugin import violations in the repo itself: the real scan reports none (see implementation record step 4).
- No push, no worktree cleanup, no destructive git commands.

## Affected files

| File | Change |
|---|---|
| `scripts/verify-plugin-imports.mjs` | Entry check fixed to `pathToFileURL(process.argv[1]).href === import.meta.url`; dead `invokedPath` variable removed; `collectTypeScriptFiles` now skips non-existent directories instead of crashing with ENOENT. |
| `scripts/verify-plugin-imports.d.mts` | New. Type declaration for the `.mjs` module so tests can import `findPluginImportViolations` under NodeNext + strict (no runtime behavior). |
| `tests/unit/scripts/verify-plugin-imports.test.ts` | New. 4 tests: CLI subprocess on violation fixture (exit 1 + descriptions), CLI subprocess on clean fixture (exit 0 + OK), direct-call coverage of the three rules plus the server-side `src/` dist-deep-path rule, and no-false-positive check for allowed imports. |

## Verification commands

All run individually in the worktree root, exit codes read separately.

| Command | Result |
|---|---|
| `node scripts/verify-plugin-imports.mjs` (before fix) | exit 0, **no output** — evidence the scan never ran (no-op gate) |
| `node scripts/verify-plugin-imports.mjs` (after fix) | exit 0, `verify-plugin-imports: OK（插件包 import 边界无违规）` |
| `node scripts/verify-plugin-imports.mjs <temp fixture with 3 violations>` | exit 1, one violation line per rule (`import Server 内部实现` / `import PI SDK` / `import 协议包 dist 深路径`) |
| `npx vitest run tests/unit/scripts/verify-plugin-imports.test.ts` | 4 passed, exit 0 |
| same test with entry check temporarily restored to an always-false comparison | 2 CLI tests fail (exit-1 and OK assertions), 2 direct-call tests pass — proves the test would have caught the audit defect; fix then restored via edit |
| `node scripts/verify-pi-sdk-imports.mjs` | exit 0 |
| `npx tsc --noEmit -p tsconfig.json` (fresh worktree, before package builds) | exit 2 — ~130 errors, all `Cannot find module '@opencolorful/plugin-protocol'` / missing exports from it; caused by the protocol package not being built yet in a fresh worktree, unrelated to this change |
| `npm run build:protocol` then `npm run build:sdk` | both exit 0 |
| `npx tsc --noEmit -p tsconfig.json` (after package builds) | exit 0 |
| `npm run check` | first run: exit 1 at `check:docs` (missing `plans/` closure, fixed by this file); re-run: exit 0, all stages green |

## Implementation record

1. Read `AGENTS.md` (quality gates, hard constraints) and audit §7.1; confirmed the defect at the old lines 81-82.
2. Reproduced the no-op: pre-fix `node scripts/verify-plugin-imports.mjs` printed nothing and exited 0.
3. Fixed the entry check to `pathToFileURL(process.argv[1]).href === import.meta.url` (imported `pathToFileURL` from `node:url`), removed the dead `invokedPath` variable and the now-unused `fileURLToPath` import.
4. Ran the real scan against the worktree: `OK` — **no real plugin import violations exist in the repo**, so no source remediation was required and no architecture-level trade-offs surfaced.
5. While validating the CLI with a minimal temp fixture, found a secondary robustness defect: `collectTypeScriptFiles` crashed with ENOENT when the scanned project root has no top-level `src/` (and would likewise crash for a `packages/*` entry without `src/`), producing a stack trace instead of a scan result. Added an `existsSync` guard consistent with the sibling script `verify-pi-sdk-imports.mjs`. This is also required for the mandated fixture-based regression test (fixtures contain only `packages/…`, no top-level `src/`).
6. Added `tests/unit/scripts/verify-plugin-imports.test.ts` (mkdtemp fixtures + `spawnSync` with `cwd` = worktree root; direct unit calls covering the three rules) and `scripts/verify-plugin-imports.d.mts` for typed import under NodeNext. Test intent comments document that the CLI assertions fail against the pre-fix code.
7. Full gate: `npm run check` — first run failed at step 1 `check:docs` (document governance correctly flagged production changes without a `plans/` closure; this plan file is that closure). Re-run after adding this file: **passed end-to-end, exit 0** (`NPM_CHECK_EXIT=0`; the `&&` chain covers check:docs, both import gates, package builds, root typecheck, root tests, root build, web tests/build, desktop tests/build). Supplementary individual runs for the record: root `npm run test` → 194 test files / 2279 tests passed, exit 0; desktop suite inside check → 20 test files / 102 tests passed.

## Exit criteria

- `node scripts/verify-plugin-imports.mjs` really scans: exit 1 with per-rule violation lines on a violation fixture; exit 0 with the OK line on a clean fixture and on this repo.
- `npx vitest run tests/unit/scripts/verify-plugin-imports.test.ts` green (4/4); the CLI assertions demonstrably fail against the pre-fix entry check.
- `node scripts/verify-pi-sdk-imports.mjs`, `npx tsc --noEmit -p tsconfig.json`, and the full `npm run check` all pass.

## Known deviations

- Beyond the entry check itself, `collectTypeScriptFiles` gained an `existsSync` guard (step 5). Behavior-preserving for valid roots; converts an ENOENT crash into a skip. Flagged here because it was not part of the original defect description.
- `scripts/verify-plugin-imports.d.mts` is a new type-shim file. It adds no runtime behavior; without it the test's direct import of the `.mjs` module fails typecheck under `strict` NodeNext.
- Violation messages keep `path.relative` output with platform-specific separators (backslash on Windows). The sibling script normalizes to `/`; not done here to keep the diff minimal — the tests assert only platform-independent fragments. Suggested as a small follow-up.
- On a fresh worktree `npx tsc --noEmit -p tsconfig.json` must run after `npm run build:protocol` / `build:sdk` (the `npm run check` ordering already encodes this). The first tsc failure in this lane was an environment artifact, not a code defect.

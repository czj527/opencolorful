# G0 Dependency Maintenance: @types/node 26.4.0

**Status:** 已完成
**Date:** 2026-09-04
**Scope:** Dependabot PR #49 only.

## Change

The dependency update exposes the Node 26 `ChildProcess.exec` error-code
typing, so `LocalBackend` now normalizes runtime exit-code values at the
process boundary: integer numbers and integer strings are preserved; signals,
non-numeric values, and non-integers become exit code `1`.

## Verification

- `npx vitest run tests/unit/local-backend.test.ts` passed: 13 tests.
- `npx tsc --noEmit -p tsconfig.json` passed.
- Root test suite and Web/Desktop builds were independently exercised on the
  stacked repair branch; no sandbox regression was observed.

## Risk

The normalization keeps the public `ExecuteResult.exitCode` numeric and stable
across Node 22 and Node 26 typings/runtimes without changing sandbox policy.

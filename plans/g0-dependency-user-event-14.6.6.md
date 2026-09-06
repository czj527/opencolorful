# G0 Dependency Maintenance: @testing-library/user-event 14.6.6

**Status:** 已完成
**Date:** 2026-09-04
**Scope:** Dependabot PR #48 only.

## Change

Upgrade `@testing-library/user-event` from `14.6.1` to `14.6.6` in the Web
workspace lockfile and manifest. This is a patch-level test dependency update;
it does not change production runtime behavior or the public protocol.

## Verification

- `npm run test --workspace=web` passed: 34 files / 426 tests.
- `npm run web:build` passed.
- `cd web; npx playwright test` passed: 59 tests.

## Risk

The upgrade changes synthetic user-event behavior used by renderer tests. The
Web unit and browser suites above are the acceptance evidence.

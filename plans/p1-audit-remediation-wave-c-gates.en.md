# P1 Audit Remediation — Wave C Entry Gates

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-08
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md`
  and the follow-up acceptance review through #81.

## Goal

Close two first-party boundary gaps discovered after the P1 audit remediation
queue was marked complete:

1. A present but corrupted Agent `settings.json` must fail closed instead of
   silently defaulting away sandbox capabilities.
2. Plugin and Skill CLI HTTP requests must use the same local Server token as
   the other trusted clients.

These are Wave C entry gates, not product acceptance or release validation.

## Changes

- `AgentStore.readSettings()` now rejects malformed or schema-invalid settings.
- Plugin and Skill CLI requests read the present Server token from the shared
  environment/runtime path and send `Authorization: Bearer <token>`.
- Added unit and integration regression coverage for both failure classes.

## Verification

```text
targeted unit/integration tests -> 56/56
typecheck                       -> pending
full Electron true-chain        -> not rerun (unchanged UI path)
human acceptance                -> pending
release/install validation      -> pending
```

## Acceptance

- [ ] Corrupted Agent settings cannot create a Runtime with weaker sandbox policy.
- [ ] Plugin CLI requests authenticate against a token-protected Server.
- [ ] Skill CLI requests authenticate against a token-protected Server.
- [ ] Wave A/B product acceptance remains separately marked `HUMAN_PENDING`.
- [ ] G2 installation, update, recovery, and formal release remain separately
      marked `RELEASE_PENDING`.

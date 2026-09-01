# Browser Capability: Security Boundary, Read-only Inspect, and Controlled Actions

**Status:** 规划中  
**Date:** 2026-08-31  
**Authoritative product spec:** [`docs/superpowers/specs/2026-08-31-browser-capability.md`](../docs/superpowers/specs/2026-08-31-browser-capability.md)  
**Current status:** [`docs/project-status.md`](../docs/project-status.md)  
**Relationship:** Independent follow-up; not part of P1 Wave B merge sequencing.

## 1. Scope and non-goals

This is an independent feature plan. It starts with a browser security contract, then delivers isolated read-only inspection, then a visible Desktop right-side panel, then controlled user-approved actions, and only last considers Agent/Plan/Cron integration.

The current product has no BrowserManager, browser runtime tool, browser route, BrowserDataSource, browser session isolation, BrowserCard or Browser Panel. Electron BrowserWindow is not a browser runtime contract. Playwright and Browser Use are acceptance tools only.

The first release explicitly does not enable arbitrary JavaScript/evaluate, arbitrary Cookie or account-state sharing, unapproved side effects, unattended automation, unrestricted download/upload, cloud-browser fallback, or page-content promotion to system instructions.

## 2. Threat model and invariants

The design must treat navigation and page content as untrusted input. It must defend against SSRF, loopback/private/metadata access, DNS rebinding, cross-session leakage, credential/cookie exposure, file upload/download abuse, page prompt injection, stale element references, action replay, runaway waits, host crashes and user cancellation races.

Required invariants:

- Browser Session identity is explicit and bound to Agent and Session.
- URL normalization and DNS/IP policy are enforced before navigation and after redirects/resolution as required by the threat model.
- Cookies, credentials, downloads and uploads are isolated and never placed in ordinary logs.
- Browser actions are auditable with correlation/session/action identifiers and safe metadata.
- Page text, snapshots and selected elements are data, never system/developer instructions.
- Every action has timeout/cancellation/error semantics; stale refs are rejected after page changes.
- Browser Panel observes the BrowserManager; it does not control arbitrary Electron WebContents directly.

## 3. Dependency graph and barriers

```text
C0 (security/threat model and contract, serial)
  -> C1 (BrowserManager/transport and read-only Inspect, serial)
      -> C2 (Desktop Browser Panel, serial)
          -> C3 (controlled actions and human element selection, serial)
              -> C4 (Agent/Plan/Cron integration, serial)
```

C0 is a mandatory barrier for all code. C1 must stabilize lifecycle, isolation and ref semantics before UI. C2 must prove visible state and cross-session isolation before actions. C3 must pass negative security and audit tests before any unattended or model-driven integration is considered. There is no parallel implementation group across these barriers; a future subtask may parallelize only within a stage after the main Agent verifies disjoint files and stable contracts.

## 4. File ownership map

| Task | Planned ownership | Explicitly excluded |
|---|---|---|
| C0 | Browser Feature Spec, threat model, security/permission contract and negative-case matrix | Runtime implementation |
| C1 | BrowserManager/transport contract, host adapter, browser persistence metadata and contract tests | Desktop UI and Agent tool wiring |
| C2 | Desktop BrowserDataSource, panel/card/projector, styles, Mock/Electron UI tests | Browser security policy changes and direct WebContents control |
| C3 | Action contract, approval/policy adapter, audit mapping, element-selection payload and UI tests | Unattended Agent/Cron execution and arbitrary evaluate |
| C4 | Agent tool/Plan/Cron adapters and integration tests only after C0-C3 evidence | Expanding C0-C3 security boundaries implicitly |

Exact paths and ownership must be re-read before dispatch. Any shared migration, security policy, event contract or route registry is assigned serially by the main Agent.

## 5. Task briefs

### C0 — Security boundary and threat model

- **role:** Define the non-negotiable browser security and product contract.
- **read_first:** This spec, `docs/architecture.md`, security/auth/sandbox/audit rules, Electron main/preload, existing HTTP validation, and reference Browser implementations in OpenHanako/OpenClaw/Hermes/CowAgent.
- **owns:** Feature Spec, threat model, URL/IP/cookie/action policy draft, approval matrix and negative-case test inventory.
- **forbidden:** No browser runtime code, no arbitrary JavaScript, no credentials, no weakening of existing sandbox/auth policies.
- **interface:** Specify BrowserSession, Agent/Session binding, navigation/action request/result, ref lifetime, audit fields, error/status taxonomy and cancellation/timeout contracts.
- **requirements:** Cover SSRF/private/metadata/DNS rebinding, redirects, cookie/credential, upload/download/evaluate, prompt injection, user confirmation and unattended boundaries.
- **acceptance:** Each threat has a mitigation and a negative test; first-release unsupported behaviors are explicit; unresolved security decisions block C1.
- **decision_mode:** `human-fixed` for security boundaries and first-release exclusions; `agent-recommends` for implementation-neutral field names.
- **report:** Threat matrix, contract version, decisions, open risks and main-Agent review.
- **docs:** This Feature Spec, a security/architecture document or ADR if the policy becomes a platform invariant, and `SECURITY.md` only where the impact matrix requires.

### C1 — Browser foundation and read-only Inspect

- **role:** Build an isolated, mockable lifecycle before any side-effecting action.
- **read_first:** C0 contract, existing runtime adapters, Electron process boundaries, persistence/migration patterns and chosen host capabilities.
- **owns:** BrowserManager/transport and host adapter, session metadata needed for isolation/recovery, read-only routes/events and contract/integration tests.
- **forbidden:** No direct arbitrary WebContents control from UI, no click/type/select/key/scroll, no Cookie sharing, no evaluate, no unrestricted URL bypass.
- **interface:** start/stop/navigate/wait/title/url/tabs/snapshot/screenshot with explicit session/Agent/Session identity, cancellation, timeout, host error and stale-ref result.
- **requirements:** Enforce C0 navigation policy, per-session isolation, page-change ref invalidation, cold start/restart recovery and safe audit metadata.
- **acceptance:** Mock and host tests cover lifecycle, allowed/blocked URL, redirect/resolution, timeout/cancel, host unavailable, stale refs, restart and cross-session isolation; no sensitive payloads persist.
- **decision_mode:** `human-fixed` for C0 invariants; `agent-recommends` for transport internals.
- **report:** Contract tests, negative output, migration/recovery evidence and risk list.
- **docs:** Update the plan and technical browser/security documentation; do not claim Desktop browser UI exists yet.

### C2 — Desktop right-side Browser Panel

- **role:** Make browser activity observable without bypassing the BrowserManager.
- **read_first:** C0-C1 contract, Desktop `DesktopDataSource`/projector patterns, right-sidebar layout, MockDataSource, Electron preload and existing screenshot/stream components.
- **owns:** BrowserDataSource methods, Browser Panel/Card/projector/styles, Mock fixtures and Desktop Mock/Electron UI tests.
- **forbidden:** No security-policy changes, no direct arbitrary WebContents control, no action buttons before C3 contract, no cross-session state reuse.
- **interface:** Consume Browser Session state/events for URL/title/tab/loading/snapshot/screenshot/status/error/stopped; preserve selected Session identity.
- **requirements:** Panel can be expanded/collapsed, clearly shows connection/loading/error/stopped states, observes Agent activity and supports safe stop; user can tell which Agent/Session owns the browser.
- **acceptance:** Real Desktop interactions show live/replayed state, panel survives reload/restart, host failure and recovery are visible, two sessions cannot display each other’s state, narrow layout does not overflow.
- **decision_mode:** `human-fixed` for right-sidebar visibility and ownership; `agent-recommends` for panel layout details.
- **report:** Screenshot/trace paths, Mock/IPC parity and cross-session evidence.
- **docs:** Update Desktop/browser design and this plan; Changelog only for visible panel delivery.

### C3 — Controlled actions and human element selection

- **role:** Add bounded actions only after read-only isolation and visibility are proven.
- **read_first:** C0-C2 contracts, approval/policy APIs, audit routes, Desktop composer attachments/structured input conventions and reference action semantics.
- **owns:** Action request/result contract, policy/approval adapter, audit event mapping, element-selection payload and associated UI/negative tests.
- **forbidden:** No arbitrary evaluate, unrestricted upload/download, account-state sharing, automatic side effects, or Agent/Cron unattended execution.
- **interface:** click/type/select/key/scroll require explicit BrowserSession/tab/ref; action result includes status, cancellation/timeout, safe error and correlation ID. Selected element reference includes URL/title/selector/snapshot time and bounded text/attributes.
- **requirements:** Reject stale refs and page changes; require confirmation for configured side effects/sensitive fields; ensure selected page data cannot alter system/developer instruction channels; provide add/remove/cancel affordances.
- **acceptance:** Positive and negative actions, approval denial, stale ref, timeout, cancellation, sensitive field, prompt injection, audit and element-to-composer provenance tests pass in Mock and Electron; no secret or page instruction leakage.
- **decision_mode:** `human-fixed` for approval and untrusted-content boundaries; `agent-recommends` for small payload presentation details.
- **report:** Action matrix, audit examples, screenshots/traces, security-negative output and unverified host limitations.
- **docs:** Update Feature Spec/security docs and Changelog for user-visible controlled actions; unsupported operations remain listed.

### C4 — Agent, Plan and Cron integration

- **role:** Consider model-driven or scheduled browser work only after all earlier evidence is complete.
- **read_first:** C0-C3 reports, Wave A model/usage policy, Wave B todo/plan contract, future cron plan, approval/audit and resilience evidence.
- **owns:** Explicitly assigned Agent browser tool, Plan/todo, Cron/Heartbeat adapters and integration tests; no shared security policy edits without a new serial task.
- **forbidden:** No implicit privilege escalation, no unattended side effects, no arbitrary evaluate/cookie/file bridge, no bypass of user approval or usage/logging policy.
- **interface:** Each integration declares required primary/secondary model role, permission, approval, timeout, retry, audit, result projection and prompt-injection handling.
- **requirements:** Start with read-only Agent use; treat actions, downloads/uploads and scheduled work as separate approvals and feature gates; record usage and action correlation without sensitive bodies.
- **acceptance:** Each enabled integration has end-to-end Mock/Electron evidence, failure/abort/restart behavior, permission-negative tests and explicit disabled-state tests for unsupported features. C4 may remain Planning if any security barrier is incomplete.
- **decision_mode:** `human-selects` for enabling high-risk integrations; `agent-recommends` for low-risk adapter details.
- **report:** Integration matrix, evidence index, disabled capabilities and open threat findings.
- **docs:** New feature specs/ADRs are required for any expansion beyond C3; update status only after independent acceptance.

## 6. Quality and security gates

Every stage runs focused unit/contract/integration tests, negative security tests, and Desktop Mock/Electron tests where applicable. Commands are separate and record exit codes. Browser acceptance must use isolated homes, faux providers where a model is involved, disposable Browser Sessions and screenshots/traces. A test tool must never be used to bypass the product policy.

Required evidence includes URL/IP policy tests, cross-session isolation, audit/redaction checks, timeout/cancel, host failure/recovery, stale refs, UI ownership, and user-selected element provenance. A child-agent report is not acceptance evidence; the main Agent independently reviews code, tests and artifacts.

## 7. Implementation log template

```text
Date:
Task:
Commit(s):
Commands and exit codes:
Evidence paths:
Observed result:
Unverified:
Security deviation or follow-up:
Main-Agent review:
```

## 8. Feature Exit Conditions

- C0 security contract and threat model have complete mitigations and negative tests.
- C1 read-only Inspect is isolated, mockable, cancellable, recoverable and auditable.
- C2 Desktop Panel visibly follows the correct Browser Session and survives reload/restart/failure.
- C3 controlled actions and human element selection enforce approval, stale-ref, provenance and prompt-injection boundaries.
- C4 is enabled only feature-by-feature with explicit permissions and end-to-end evidence; unsupported evaluate/cookie/upload/download/unattended paths remain disabled and documented.
- The plan remains Planning until the main Agent independently verifies all evidence. Planning, code merge, or a green CI job alone never means browser capability is complete.

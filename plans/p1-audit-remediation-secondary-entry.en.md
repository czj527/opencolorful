# P1 Audit Remediation — Desktop Secondary Model Entry (#80)

- **Status**: Implemented (pending review/merge)
- **Date**: 2026-09-08
- **Audit ref**: `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §7.4 "Secondary 模型 Desktop 入口不完整" / §10 queue item 9.

## Goal

Users must be able to configure the secondary model (shared by Subagent threads, Memory utility calls, and background review/compaction) from the Desktop settings — the primary product frontend — instead of only the web ops client.

## Non-goals

- No backend change: `PUT /api/settings/preferences` already accepts `subagents.defaultModel` (null or `{providerId, modelId}`) with a `modelService.resolveModel` availability check returning 400.
- No per-Agent override UI (A6 contract keeps per-Agent settings separate); no third model tier; no dynamic routing.

## Defect analysis

The Desktop `PreferencesView` type carried only the `defaults` segment, and the models settings category rendered a single primary-model row. `subagents.defaultModel` was invisible and unconfigurable from Desktop even though the backend contract and the web `SubagentDefaultsSection` existed — a cross-client configuration gap (audit §7.4).

## Fix

- `PreferencesView` gains `subagents: { defaultModel: ModelRef | null }`; `updatePreferences` patch type gains an optional `subagents` segment (both optional, matching the server merge semantics).
- `IpcDataSource.getPreferences` maps `subagents.defaultModel` defensively (missing segment / old backend → null); `MockDataSource` mirrors the same shape and merge behavior.
- `DefaultModelRow` generalizes to a `scope` prop ("defaults" | "subagents"): the secondary row reads/writes `subagents.defaultModel`, shows the same credential-filtered model list, and renders the shared "未设置" option. The primary row is unchanged.
- The two rows sit side by side in the "模型与 Provider" category: 默认模型（全局默认模型）+ Secondary 模型（Subagent / 后台任务模型）.

## Tests

`desktop/src/settings.mock.test.tsx` gains 4 cases (SEC-01..04): the Secondary row exists next to the primary row with "未设置" initial state; switching writes exactly `{ subagents: { defaultModel: {...} } }` (no `defaults` segment in the patch — assertion on captured patch shape); clearing writes `null`; a rejected save (server 400 semantics) surfaces the mapped error line and the select reverts.

Discriminating mutation (run then reverted): pointing the secondary row's write at `defaults` instead of `subagents` fails exactly SEC-02/03/04 (3/14) while existence and primary-row cases stay green.

## Companion fix: extension loading isolated from user's global PI config (#80 scope)

While verifying this batch on a machine that had just gained user-level PI extensions (`~/.pi/agent/extensions/orca-*.ts`), **every Session Runtime creation returned 500** on an otherwise green `main` tree (`Sandbox extension count mismatch: expected 1, got 4`). Root cause: PI's `discoverAndLoadExtensions(paths, cwd, agentDir = getAgentDir())` scans the user's global `~/.pi/agent/extensions/` directory in addition to the explicit paths; our four platform extension load sites (sandbox / memory-tools / skill-tools / subagent-tools in `src/pi-sdk/agent-session.ts`) omitted the third argument, so any user-installed pi extension got pulled into the load result and tripped the sandbox count fail-closed check. The same omission existed in `tests/unit/sandbox-extension.test.ts`.

Fix: all four load sites (and the unit test) pass an explicit `ISOLATED_AGENT_DIR` (a path guaranteed not to exist under `os.tmpdir()`), collapsing the discovery surface to the explicit platform paths. Discriminating mutation: removing the third argument reproduces the 500 in `tests/integration/session-todo-tool.test.ts` (1/8 fails); with the fix the previously failing 9-file/12-case set is green. This is an environment-dependent product defect (fail-closed misfiring on legitimate user state), not test flakiness — it belongs in this remediation PR because it blocks the queue's verification gate on developer machines with pi extensions installed.

## Verification

```text
desktop unit suite (vitest)                    -> 120/120 (was 116 + 4 new)
npm run check                                  -> green
full true-chain desktop e2e suite              -> 29/29
```

## Known limitations

- Desktop currently has no indicator of *which* sessions actually used the secondary model; per-call attribution is the A8 usage page's concern (source/role filters), not the settings entry.
- The 400 rejection message is mapped by the shared error classifier; because the server text mentions 凭据, it surfaces as the credentials-expired advice line. Specific error-code handling for `subagents.defaultModel` rejections can be refined when settings errors get their own context key.

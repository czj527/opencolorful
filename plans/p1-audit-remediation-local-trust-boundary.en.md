# P1 Audit Remediation — Local HTTP/WS Trust Boundary (P0-1)

**Date:** 2026-09-06
**Status:** Implemented on branch `p1-audit-fix-local-trust-boundary` (worktree `wt-trust-boundary`), awaiting main-agent review
**Audit source:** `docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md` §5 P0-1
**Lane:** Lane ② (independent implementation lane; code reviewed independently by main agent)

## 1. Goal

Close the confirmed P0-1: the desktop's local service (default `127.0.0.1:4310`) had no unified
trust boundary. Reproduced by the audit: a cross-site simple request
(`Origin: https://evil.example` + `Content-Type: text/plain`) could `POST /api/sessions` → 201;
a forged `Host: evil.example` also succeeded; a WebSocket handshake with an evil Origin connected.
The only Origin check (`isLocalUiOrigin`) guarded a single observability route.

Delivered: a startup-generated access token, a global HTTP middleware (Host / token /
JSON Content-Type / Origin rules), WS handshake validation, and wiring of all first-party trusted
clients — with fail-closed semantics everywhere (no bypass switches).

## 2. Non-goals

- No change to route/business logic, storage, or API shapes (error bodies are the existing
  stable `{code, message}` JSON shape with 403/415).
- No TLS/mTLS, no multi-client auth model, no user-facing permission system — single local
  machine token per server home.
- No changes to `package.json`, `CHANGELOG.md`, `docs/project-status.md`, existing `plans/*.md`
  or `docs/superpowers/specs/*` (main agent consolidates those).

## 3. Threat model (summary)

| Threat | Defense |
|---|---|
| Cross-site simple request (CSRF write) | Writes require the token; browsers cannot read the token file → 403. Belt-and-braces: Origin rule at token-less paths. |
| DNS rebinding | Every request (no bypass): `Host` header must be loopback (`localhost` / `127.0.0.1` / `::1`, port ignored) or the configured bind host. |
| Cross-site content-type confusion (`text/plain` CSRF) | Writes with a body must send `application/json` (tolerates `; charset=`), else 415. |
| Malicious-Origin WebSocket handshake | WS: if `Origin` is present it must be local (even with a token); if absent, a valid `?token=` is required → else 403. |
| Cross-site read | No CORS headers anywhere; Host check; reads stay token-less by design (local processes could read the token file anyway). |
| Timing side-channel on token compare | sha256-digest + `timingSafeEqual` comparison (length-independent). |

## 4. Files touched

**Server core (new)**
- `src/server/trust-boundary.ts` — token generation/resolution/persistence (`crypto.randomBytes(32)` hex; env `OPENCOLORFUL_SERVER_TOKEN` > `<OPENCOLORFUL_HOME>/runtime/server-token` (0600, atomic tmp+rename, warn-only on failure) > generate+persist); `readPresentServerToken` (read-only client variant); `tokenMatches`; `presentedToken` (Authorization Bearer / X-OC-Token); `hostHeaderName`/`isLocalHostHeader`; `createTrustBoundaryMiddleware` (strict / origin-guard modes, uniform HTTP + WS upgrade handling).

**Server wiring**
- `src/server/app.ts` — `trustBoundary` option, middleware mounted before every other middleware/route, `ServerAppResult.token` exposed (random ephemeral token when not injected).
- `src/server/start.ts` — resolves the startup token (env > file > generate+persist), passes `{token, bindHost}` (not overridable via `appOptions`), `RunningServer.token`.

**Supervisor**
- `src/supervisor/app.ts` — same middleware in `origin-guard` mode (writes: valid token **or** local Origin; browser pages served by the supervisor hold no token); WS proxy attaches `?token=` upstream; HTTP proxy elevates forwarded requests with the token when the client presented none (only requests that already passed this layer reach the proxy).
- `src/supervisor/start.ts` — resolves the shared token (same file as the agent server), `RunningSupervisor.token`.

**Trusted clients**
- `src/cli/chat-command.ts`, `src/tui/app.ts`, `src/tui/api-client.ts` — CLI chat resolves the token read-only (env > file) and sends `x-oc-token` on all TUI API calls.
- `desktop/electron/token-source.cjs` (new), `desktop/electron/api-proxy.cjs` — main-process proxy (the only network egress of the sandboxed renderer) attaches `Authorization: Bearer` from env/token-file, invalidates its cache on 403 (self-heal after token rotation).
- `web/vite.config.ts` — dev proxy injects the token on `proxyReq`/`proxyReqWs` for `/api` and `/ws` (lazy env > file read with 2 s TTL cache).
- `web/playwright.config.ts` — Web E2E: pins one E2E token via `OPENCOLORFUL_SERVER_TOKEN` (inherited by every spec-started supervisor **and** its spawned agent-server child through env priority) and attaches it to all Playwright `page.request` (APIRequestContext, Node-side, Origin-less) seeding calls via `extraHTTPHeaders`; browser flows keep using the same-origin local-Origin rule.

**Tests**
- `tests/fixtures/trusted-app.ts` (new) — central harness: same assembly as `createServerApp`, returned app auto-attaches its own token + JSON Content-Type on `request()`/`fetch()` (explicit headers are never overridden). Tests go through the real middleware with presented credentials.
- 26 existing test files switched to `createTrustedServerApp`; test URL hosts normalized to `127.0.0.1`.
- Real-server tests updated to present tokens: `tests/e2e/server-restart.test.ts`, `tests/e2e/real-provider-tools.test.ts`, `tests/integration/observability-server.test.ts`, `tests/integration/tui-smoke.test.ts`, `tests/integration/tui-real-runtime.test.ts`, `tests/integration/ws-session.test.ts` (`?token=`), `tests/integration/supervisor.test.ts`.
- New: `tests/integration/trust-boundary.test.ts` (17 cases, real ports + isolated `OPENCOLORFUL_HOME`), `tests/unit/trust-boundary.test.ts` (12 cases).
- Web e2e: `web/tests/e2e/plugin-lifecycle.spec.ts`, `web/tests/e2e/skill-lifecycle.spec.ts` — direct Node-side `api()` helpers now carry `x-oc-token` from `RunningSupervisor.token`.

## 5. Verification

| Command | Result |
|---|---|
| `npx vitest run tests/unit/trust-boundary.test.ts tests/integration/trust-boundary.test.ts` | 29/29 passed |
| `npx vitest run` (root, full) | 195 files / 2304 tests passed, exit 0 |
| `npx tsc --noEmit -p tsconfig.json` | clean (after `build:protocol` + `build:sdk`) |
| `npm run web:test` | 428/428 passed |
| `npm run web:build` | success |
| `cd web && npx playwright test` | 60/60 passed (baseline met) |
| `cd desktop && npx tsc --noEmit` (+ `tsconfig.tests.json`) | clean |
| `npm run desktop:test` | 102/102 passed |
| desktop true-chain `--grep @smoke` | 1 passed (requires `desktop/dist` renderer build; first run failed only because dist was absent in the fresh worktree) |
| `npm run check` (full gate) | see final report |

## 6. Implementation record — reconnaissance findings

- **WS registration points:** `src/server/app.ts` (`/ws`, `createNodeWebSocket().upgradeWebSocket`) and `src/supervisor/app.ts` (`/ws` upstream proxy). `@hono/node-ws`'s `injectWebSocket` routes upgrade requests through the full Hono pipeline (`app.request`), so a global middleware rejection surfaces as a non-101 HTTP response written to the socket — one middleware covers HTTP and WS uniformly.
- **Electron topology:** the renderer is sandboxed and makes **no direct network calls**; all traffic goes over IPC to the main process (`desktop/electron/api-proxy.cjs` for JSON APIs, `sse-proxy.cjs` for SSE reads, both preferring supervisor 4311 then agent server 4310; `OPENCOLORFUL_SERVER_URL` override). The desktop renderer never opens a WebSocket. → Token injection point: main-process proxies only; the token never enters the renderer.
- **Web client:** `ApiClient` (single `request` method), `SseClient` (EventSource, GET), `WsClient` (browser WebSocket); `API_BASE = ""` → always same-origin (vite dev proxy in dev, supervisor static hosting in production). Browser-side code never holds the token — the trusted local proxies (vite dev proxy, supervisor) inject it.
- **CLI:** `server`/`supervisor` spawn processes; `chat` → `TuiApp` → `TuiApiClient` (fetch, has writes) → token wired; no other HTTP callers.
- **Test infrastructure:** no central harness existed — 25 test files built apps via `createServerApp` (306 `app.request` call sites), 7 used real `startForegroundServer` servers; web e2e boots a real supervisor + built web dist; desktop true-chain boots electron against a real server started in a child process (`server-bootstrap.ts`), with `OPENCOLORFUL_HOME` already pointed at an isolated temp dir (so the CJS token reader finds the bootstrap server's token file without further changes).
- **Log audit for token leakage:** the access-log middleware logs `pathname` only (no query — `?token=` never logged); the WS path skips request logging entirely; runtime state file (`server.json`) holds no token; supervisor log sanitization already redacts `Authorization` headers.

## 7. Design decisions

1. **Token injection points** — Electron: main-process `api-proxy.cjs` (renderer never sees the token; SSE is GET-only and needs none). Web: vite dev proxy + supervisor proxy (browser cannot read env/files; baking the token into the JS bundle would leak it to every page served). CLI/TUI: read-only resolution (env > file), never generates.
2. **Supervisor mode (`origin-guard`)** — the frozen contract targets the agent server. The supervisor is additionally hardened with the same Host + WS rules; its own write endpoints (start/stop/restart) accept "valid token **or** local Origin" because the supervisor-hosted browser UI holds no token, while a cross-site browser request always carries a non-local Origin → 403. Data-plane writes remain token-enforced at the agent server: the supervisor only elevates (attaches its token) requests that already passed this layer. A no-Origin, no-token Node-side write therefore cannot ride the supervisor to bypass the agent server's token gate.
3. **WS vs HTTP asymmetry (per contract)** — HTTP writes: valid token skips the Origin check (Electron production renderer may send `Origin: null` / `file://`). WS: an existing non-local Origin is rejected even with a token (the contract's parenthetical "Origin 存在时必须本机"), because a browser always attaches Origin and `?token=` is the only header-free channel.
4. **No CORS existed** — nothing to tighten; reads rely on SOP (no CORS headers were ever emitted).
5. **Test adaptation without weakening** — the central harness presents the token like a real client (real middleware evaluation); negative-path tests use raw fetch/node:http/WebSocket against real ports. No test-mode bypass env var exists.

## 8. Exit criteria

- All negative cases from the audit reproduce as rejections (cross-site simple request → 403, forged Host → 403, missing/wrong token → 403, `text/plain` body → 415, evil-Origin WS → 403) — covered in `tests/integration/trust-boundary.test.ts`.
- All positive paths (local Origin + token, curl-style + token, tokenless reads, token + evil Origin write, `?token=` WS, local-Origin WS) pass.
- All first-party clients wired (Electron main proxy, web via proxies, CLI/TUI); full quality gate green.

## 9. Known deviations / risks

- **`Content-Length`-based body detection:** the 415 rule triggers on `content-length > 0` or `transfer-encoding` presence; chunked JSON without either would still pass CT validation (no first-party client does this).
- **Bind-host nuance:** if the server is explicitly bound to a non-loopback interface, requests whose `Host` differs textually from the configured bind host are rejected (documented limitation; default remains `127.0.0.1`).
- **Supervisor control-plane writes** accept local-Origin tokenless requests (see §7.2) — deliberate, does not weaken the agent-server data plane; noted for the reviewer.
- **Dev-mode token discovery:** the desktop main process and vite proxy locate the token via `OPENCOLORFUL_HOME` (or `~/.opencolorful`); pointing the server and the client at different homes in dev requires sharing `OPENCOLORFUL_SERVER_TOKEN` explicitly (packaged/true-chain paths are self-consistent).
- **Windows file mode:** 0600 is best-effort (`fs.chmodSync`); the strict mode assertion is POSIX-only in tests.

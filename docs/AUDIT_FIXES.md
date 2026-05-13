# OmniRoute 3.8 Audit Fix Reference

This document explains the audit-wave changes shipped in commits `642c3b5`..`55a95a3` and is intended to make it easier to understand what changed, why, and how to operate the result. If you are upgrading from a pre-3.8 install, **read this end-to-end**.

## TL;DR — what to do on upgrade

1. Set `STORAGE_ENCRYPTION_KEY` if you haven't (or accept the auto-generated value in `~/.omniroute/server.env`). In `NODE_ENV=production` the process now refuses to start without it. Override with `OMNIROUTE_ALLOW_PLAINTEXT_STORAGE=true` if you knowingly want plaintext on disk (development only).
2. If you run behind a reverse proxy, set `TRUST_PROXY_HEADERS=true` (or scope it via `TRUST_PROXY_FROM=<cidrs>`). Without it the brute-force guard treats every request as coming from the same loopback IP.
3. If your dashboard is hosted on a non-`Host`-matching origin, set `OMNIROUTE_DASHBOARD_ALLOWED_ORIGINS=<list>` to satisfy the new CSRF guard.
4. If you connect MCP clients to `/api/mcp/sse` or `/api/mcp/stream`, they now need a management session or a `manage`-scoped API key. For local dev only you can set `OMNIROUTE_MCP_ALLOW_ANONYMOUS=true`.
5. If you have OAuth provider connections (Gemini, Antigravity) that were relying on the hardcoded Google `client_secret` fallback in source, set `GEMINI_CLI_OAUTH_CLIENT_SECRET` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`. The hardcoded fallbacks were removed.
6. If you have an existing `auth_token` cookie that was issued without a `jti` claim, log in again — the new server-side denylist requires the `jti` claim to track revocation.

## Changes by area

### 1. Auth & sessions

| Change                                          | Where                                                            | User impact                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js middleware activated                    | `src/middleware.ts` (renamed from `src/proxy.ts`)                | Authz pipeline (route classification, CORS, body size limits, security headers) now runs globally. Previously it was unreachable.                                                            |
| `REQUIRE_API_KEY=true` actually rejects anonymous chat | `src/app/api/v1/_helpers/apiKeyScope.ts`                  | Chat / responses / messages / completions / images / audio etc. now return 401 when the env is enabled and no key is provided. Loopback bootstrap is still permitted.                          |
| `INITIAL_PASSWORD` requires rotation on first login | `src/lib/auth/managementPassword.ts`, `auth/login/route.ts`  | First successful login after env-bootstrap returns `{ mustChangePassword: true, tempToken }` and does NOT issue a session JWT. The dashboard prompts for a new password.                     |
| JWT `jti` claim + server-side denylist          | `src/lib/auth/sessionRegistry.ts`, login/logout/status routes    | Logout now revokes the token (it was previously only a client-side cookie clear). Stolen tokens can be invalidated. 30-day default reduced to 7 days, env-overridable.                       |
| Cookie `Max-Age` set                            | `auth/login/route.ts`                                            | Auth cookie is no longer a session-only cookie. Survives browser restart up to JWT TTL.                                                                                                       |
| `X-Forwarded-For` only trusted when configured  | `src/lib/ipUtils.ts`                                             | Spoofing the brute-force guard via XFF rotation is no longer trivial. Set `TRUST_PROXY_HEADERS=true` or `TRUST_PROXY_FROM=<cidrs>` if you have a real reverse proxy.                            |
| Global brute-force counter                      | `src/server/auth/loginGuard.ts`                                  | Additional global counter (`LOGIN_GUARD_GLOBAL_*`) trips a server-wide login lockout when the per-IP counters are bypassed by IP rotation.                                                    |
| bcrypt cost: 12 → 14                            | `src/lib/auth/managementPassword.ts`                             | Slightly slower login (~1.5s) but materially harder to brute-force. Override via `OMNIROUTE_BCRYPT_COST` (10–15).                                                                              |
| CSRF guard on state-changing `/api/*`           | `src/lib/api/requireManagementAuth.ts`                           | Session-cookie auth requires a matching `Origin` header on POST/PUT/PATCH/DELETE. Bearer-token auth is exempt. Allowlist via `OMNIROUTE_DASHBOARD_ALLOWED_ORIGINS`.                            |

### 2. API surface

| Change                                       | Where                                                                                            | User impact                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zod validation on chat-style routes          | `v1ChatCompletionsSchema`, `v1VideoGenerationSchema`, `v1MusicGenerationSchema`, audio multipart | Malformed bodies return a 400 with OpenAI-shape error before any provider call. Required fields are explicit.                                                                        |
| Prompt-injection guard moved into `handleChat` | `src/sse/handlers/chat.ts`                                                                     | `/v1/responses` and `/v1/messages` now also run the injection guard; previously it was only on `/v1/chat/completions`.                                                                |
| CORS preflight `Access-Control-Allow-Headers` is an explicit list | All `/v1/*` and `/v1beta/*` OPTIONS handlers                                  | No more wildcard. SDKs that need additional headers should send them; the list covers Authorization, Content-Type, Accept, User-Agent, X-Requested-With, X-API-Key, X-OmniRoute-API-Key, X-Stainless-Retry-Count, anthropic-version, anthropic-beta, openai-organization, openai-project, openai-beta. |
| `~76` management routes now auth-gated       | Many under `src/app/api/`                                                                        | Previously-unauthenticated admin endpoints (resilience reset, upstream-proxy CRUD, provider-nodes, sync, telemetry, MCP audit, etc.) now require management auth.                     |
| `/api/cli-tools/keys` no longer returns raw keys | `cli-tools/keys/route.ts`                                                                    | The legacy "dump everything" pattern is gone. Use `/api/keys/[id]/reveal` for the single-key flow (now audit-logged).                                                                  |
| `ip_allowlist` per-key enforced              | `src/shared/utils/apiKeyPolicy.ts`                                                               | The DB column has existed since migration 032 but was unused. It's now actually checked.                                                                                              |

### 3. MCP / A2A / Skills

| Change                                       | Where                                                                       | User impact                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP HTTP transports require auth             | `src/app/api/mcp/sse/route.ts`, `mcp/stream/route.ts`                       | Both transports go through `requireManagementAuth`. Set `OMNIROUTE_MCP_ALLOW_ANONYMOUS=true` to opt out for local dev.                                            |
| MCP scope `_meta` source removed             | `open-sse/mcp-server/scopeEnforcement.ts`                                   | Caller-supplied `_meta.scopes` is no longer honored. Scopes come only from `authInfo.scopes` (i.e., from the bound API key / session).                            |
| Memory + Skill MCP tools bind tenant to auth | `open-sse/mcp-server/tools/{memoryTools,skillTools}.ts`                     | `apiKeyId` is no longer a tool input; it's resolved from `authInfo` so callers cannot read/mutate other tenants' memories or run other tenants' skills.            |
| `cache_flush` requires explicit scope         | `open-sse/mcp-server/tools/advancedTools.ts`                                | Empty args no longer wipe all caches. Pass `confirmAll: true` (logged as high-severity audit event) or scope by `signature | provider | model | scope`.            |
| A2A `/a2a` default-deny                      | `src/app/a2a/route.ts`                                                      | When `OMNIROUTE_API_KEY` is unset, only loopback requests pass. Constant-time token compare; batch requests rejected; notifications return 204 per JSON-RPC 2.0. |
| Skill concurrency cap                        | `src/lib/skills/executor.ts`                                                | Max 8 concurrent skill executions per API key (env `OMNIROUTE_SKILL_MAX_CONCURRENT_PER_KEY`). Excess requests are rejected with a clear error.                    |
| Skill execution timeout cleared on finish    | `src/lib/skills/executor.ts`                                                | The race-timer is now cleared in a `finally` so long-running processes don't accumulate scheduler slots.                                                          |

### 4. Compression

| Change                                       | Where                                                                       | User impact                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lite` tool-result truncation is JSON-aware  | `open-sse/services/compression/lite.ts`                                     | A tool message that happens to be JSON is no longer sliced mid-byte; the truncator parses it and trims at object/array boundaries.                            |
| `ultra` + `aggressive` skip tool messages    | `open-sse/services/compression/{ultra,aggressive}.ts`                       | `role:"tool"`/`function` and non-text content blocks (tool_use / tool_result) are no longer mangled by the heuristic pruner.                                  |
| RTK raw-output cleanup scheduler             | `open-sse/services/compression/rawOutputScheduler.ts`                       | Raw outputs default-TTL is 7 days. Files older than `OMNIROUTE_RTK_RAW_OUTPUT_TTL_MS` are removed every 6h.                                                   |
| RTK redaction expanded                       | `open-sse/services/compression/engines/rtk/rawOutput.ts`                    | GitHub PATs (`ghp_*`, `gho_*`, `ghs_*`), Stripe live keys, Google API keys, Slack tokens, AWS access keys, JWTs, BEGIN PRIVATE KEY blocks, and connection URIs are now scrubbed. |
| `caveman` sanity check                       | `open-sse/services/compression/caveman.ts`                                  | If a rule pass produces output longer than 110% of the input or empty, the original text is returned.                                                         |
| `contextHandoff` prompt-template literal     | `open-sse/services/contextHandoff.ts`                                       | `String.replace`'s `$&` interpretation can't be abused by adversarial history content.                                                                         |

### 5. Routing, fallback, cache

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Circuit breaker `_acquireProbe()` invariant  | `src/shared/utils/circuitBreaker.ts`, `src/sse/handlers/chatHelpers.ts`     | Direct callers (chatHelpers) now go through `_acquireProbe()` and signal outcomes via `_onSuccess`/`_onFailure` explicitly. Eliminates probe-budget leak.    |
| Provider-failure recording fixed             | `src/sse/handlers/chatHelpers.ts`                                           | The `chatFn` non-throw contract no longer hides upstream 5xx from the breaker.                                                                              |
| Per-provider account-selection mutex         | `src/sse/services/auth.ts`                                                  | Unrelated providers no longer block each other during account selection. Same provider remains serialized.                                                  |
| Weighted account strategy actually weighted  | `src/sse/services/auth.ts`                                                  | Weight derived from `priority` (until a `weight` column exists). Previously fell through to fill-first.                                                     |
| Semantic cache scoped per-key                | `src/lib/semanticCache.ts`                                                  | Cache signature now includes `apiKeyId`, `tool_choice`, `seed`, `max_tokens`, `stop`, `logit_bias`, `parallel_tool_calls`, `reasoning_effort`. No cross-tenant cache hits. |
| Cooldown jitter                              | `open-sse/services/accountFallback.ts`                                      | ±15% jitter applied to exponential cooldowns. Thundering-herd of recoveries is broken up.                                                                   |
| Failure-dedup map evicts half on cap         | `open-sse/services/accountFallback.ts`                                      | Was clearing entire dedup state at once (creating a herd window). Now evicts the older half.                                                                |
| `markMutexes.delete` race fixed              | `src/sse/services/auth.ts`                                                  | Compare-and-swap prevents a successor's mutex from being deleted by a predecessor's `finally`.                                                              |
| OAuth refresh fetches now time out           | `open-sse/services/tokenRefresh.ts`                                         | All 11+ refresh paths use `AbortSignal.timeout(30s)`. A stuck refresh no longer wedges the per-connection mutex forever.                                    |
| `comboResolver.ts` legacy module removed     | `src/domain/comboResolver.ts`                                               | Was orphan code with a process-local round-robin counter. Runtime always uses `open-sse/services/combo.ts`.                                                 |

### 6. Persistence

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanup.ts` table names corrected           | `src/lib/db/cleanup.ts`                                                     | `mcp_tool_audit`, `a2a_task_events`, `memories` retention now actually runs (was silently failing against non-existent table names).                       |
| Retention scheduler wired                    | `src/lib/jobs/retentionCleanupJob.ts`                                       | Runs every 6h, env-overridable via `OMNIROUTE_RETENTION_CLEANUP_INTERVAL_MS`. Cleanup itself happens in `cleanup.ts`.                                       |
| `restoreDbBackup` re-runs migrations         | `src/lib/db/backup.ts`                                                      | Restoring an old backup onto newer code now runs the migration runner before the DB is used. On failure, the pre-restore snapshot is automatically restored. |
| Encryption refuses to start in production    | `src/lib/db/encryption.ts`                                                  | `STORAGE_ENCRYPTION_KEY` is required in `NODE_ENV=production`. Override via `OMNIROUTE_ALLOW_PLAINTEXT_STORAGE=true`.                                       |
| Encryption auth-tag mismatch surfaces loudly | `src/lib/db/encryption.ts`                                                  | Wrong-key decrypts throw `EncryptionKeyMismatchError`; after 5 failures in 60s the module short-circuits and logs CRITICAL.                                  |
| Secrets table values now encrypted           | `src/lib/db/secrets.ts`                                                     | `JWT_SECRET`, `API_KEY_SECRET`, `STORAGE_ENCRYPTION_KEY` (when persisted) wrap through `encrypt()`. Legacy plaintext rows still decode via passthrough.       |
| `version_manager` keys encrypted             | `src/lib/db/versionManager.ts`                                              | CLIProxyAPI `api_key` / `management_key` no longer stored plaintext.                                                                                        |
| `sessionAccountAffinity` actually implemented | `src/lib/db/sessionAccountAffinity.ts`                                     | Was a no-op stub. Now reads/writes `session_account_affinity` (migration 050) so session pinning works.                                                     |
| Migration contiguity guard                   | `src/lib/db/migrationRunner.ts`                                             | Warns at startup when version numbers have gaps (e.g. the existing `026` gap). Set `OMNIROUTE_STRICT_MIGRATION_NUMBERING=true` to make it fatal.            |
| `compressionScheduler` clean shutdown        | `src/lib/db/compressionScheduler.ts`                                        | Timer is `unref()`'d and cleared on SIGTERM/SIGINT. Eliminates hot-reload timer leaks.                                                                       |

### 7. Provider executors

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kie` registered                             | `open-sse/executors/index.ts`                                               | `getExecutor("kie")` returns the dedicated executor instead of falling back to `DefaultExecutor`.                                                          |
| `opencode` no longer race-prone              | `open-sse/executors/opencode.ts`                                            | Per-request format passed explicitly instead of being held on the singleton instance.                                                                       |
| `vertex` returns new credentials object      | `open-sse/executors/vertex.ts`                                              | Caller's credentials no longer mutated; refuses to proceed when `project` resolves to `"unknown-project"`; uses upstream `expires_in`.                       |
| `petals` usage accounting                    | `open-sse/executors/petals.ts`                                              | `prompt_tokens` is estimated from input messages instead of being set equal to `completion_tokens`.                                                        |
| `github` reasoning gating                    | `open-sse/executors/github.ts`                                              | `reasoning_content` is only stripped from history when the target model doesn't accept it (instead of unconditionally).                                    |
| Stream-killing fetch timeouts fixed          | `open-sse/executors/{grok-web,muse-spark-web,blackbox-web,gitlab,cliproxyapi}.ts` | `AbortSignal.timeout(...)` replaced with a `setTimeout`/`clearTimeout` pair that only times out the fetch-start phase, not the streaming body.        |
| Missing fetch-start timeouts added           | `open-sse/executors/{qoder,kiro,perplexity-web,petals}.ts`                  | All executors now have a fetch-start timeout, so a hung upstream never holds a request indefinitely.                                                       |

### 8. SSRF / network egress

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook delivery uses `safeOutboundFetch`    | `src/lib/webhookDispatcher.ts`                                              | Webhooks pointing at private/loopback/link-local/IMDS addresses are rejected with `blocked_target`. AWS metadata exfiltration via webhook test is closed.   |
| Favicon proxy uses `validateOutboundUrl`     | `src/app/api/settings/favicon/route.ts`                                     | Same guard as webhooks.                                                                                                                                    |
| Provider-node `baseUrl` validated            | `src/app/api/provider-nodes/route.ts`                                       | Same guard. Override with `OMNIROUTE_ALLOW_PRIVATE_BASEURLS=true` for internal-LLM deployments.                                                            |
| Header sanitization expanded                 | `src/shared/constants/upstreamHeaders.ts`                                   | Denylist now covers `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `origin`, `referer`, `x-forwarded-*`, `forwarded`, `cf-connecting-ip`. |

### 9. Browser security

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vary: Origin` on every authz-stamped response | `src/server/authz/pipeline.ts`                                            | CDNs / browsers can't accidentally serve cross-origin allow-lists meant for a different origin.                                                            |
| `X-Content-Type-Options: nosniff`            | `src/server/authz/pipeline.ts`                                              | Always applied.                                                                                                                                            |
| `Referrer-Policy: strict-origin-when-cross-origin` | `src/server/authz/pipeline.ts`                                        | Always applied.                                                                                                                                            |
| `X-Frame-Options: DENY` (dashboard)          | `src/server/authz/pipeline.ts`                                              | Dashboard routes only. Click-jacking protection.                                                                                                           |
| `Permissions-Policy` (dashboard)             | `src/server/authz/pipeline.ts`                                              | Disables geolocation/microphone/camera/payment by default.                                                                                                  |
| Optional `Strict-Transport-Security`         | `src/server/authz/pipeline.ts`, env `OMNIROUTE_ENABLE_HSTS=true`            | Off by default (loopback deployments don't want it). Set the env to opt in.                                                                                |
| OAuth callback `postMessage` origin pinned   | `src/app/callback/page.tsx`                                                 | No more wildcard `*`. Limits the blast radius of an attacker-controlled opener.                                                                            |
| OAuth `state` validated server-side          | `src/lib/oauth/stateStore.ts`, `oauth/[provider]/[action]/route.ts`         | Single-use, 10-minute TTL, provider-bound. CSRF / login-CSRF in the OAuth onboarding flow is closed.                                                       |
| Hardcoded OAuth `client_secret` removed      | `src/lib/oauth/constants/oauth.ts`                                          | Gemini and Antigravity flows now refuse to start if their `*_OAUTH_CLIENT_SECRET` env vars aren't set.                                                     |

### 10. Logging & audit

| Change                                       | Where                                                                       | User impact                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/keys/[id]/reveal` audit-logged         | `src/app/api/keys/[id]/reveal/route.ts`                                     | Every reveal / deny / not-found / error event lands in the audit log with actor IP and target key id.                                                       |
| `/api/keys/[id]/regenerate` audit-logged     | `src/app/api/keys/[id]/regenerate/route.ts`                                 | Same.                                                                                                                                                       |
| Login error bcrypt-hash scrubbing            | `src/app/api/auth/login/route.ts`                                           | `console.error` and audit metadata strip `$2[aby]$..` patterns. Defense-in-depth against accidental hash exfiltration.                                      |

## Footguns we did NOT close (and why)

- **`OMNIROUTE_API_KEY` env still grants implicit `manage` scope and cannot be revoked via the DB.** Documented in `SECURITY.md` "Bootstrap API Key". A rotation procedure is provided.
- **In-process state is not shared across workers.** Circuit breakers, brute-force counters, and the JTI denylist live in memory; if you cluster the server, the counters multiply by worker count. Replace with Redis-backed state if you scale horizontally — TODO.
- **Migration 026 is a real gap.** The contiguity guard warns at startup. A backfill migration would close it, but renumbering is destructive; we left it loud.
- **`open-sse/` is still excluded from the root tsconfig.** Use `npm run typecheck:full` to surface the errors. Removing the exclusion in `tsconfig.json` surfaced 30+ pre-existing errors that need separate cleanup.

## How to verify the fixes locally

```bash
npm run typecheck:core                # Clean
npm run typecheck:full                # Will show open-sse errors — known, not introduced by these changes
node --import tsx/esm --test tests/unit/safe-outbound-fetch.test.ts
node --import tsx/esm --test tests/unit/compression-role-guard.test.ts
node --import tsx/esm --test tests/unit/memory-route-auth.test.ts
node --import tsx/esm --test tests/unit/policies-route-auth.test.ts
node --import tsx/esm --test tests/unit/assess-route-auth.test.ts
node --import tsx/esm --test tests/unit/anthropic-cache-fingerprint.test.ts
```

## Where to look next

- `docs/ENVIRONMENT.md` — full env-var reference, including a new "Security & Resilience Tunables" section.
- `SECURITY.md` — the threat model and bootstrap-key documentation.
- `CLAUDE.md` — the operator handbook used by automation.

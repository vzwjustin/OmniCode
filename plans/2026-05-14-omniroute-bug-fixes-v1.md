# omniroute Bug Fixes — Implementation Plan

## Objective

Address 24 concrete bugs identified during the 2026-05-14 code review of the omniroute codebase, prioritized by security/data-integrity impact. The plan delivers fixes in three tranches — **Critical (data-at-rest & authz)**, **High (OAuth correctness & API surface)**, and **Medium/Low (resource leaks, defense-in-depth, hygiene)** — so a Forge agent can land each tranche as a focused PR with full test coverage.

Every fix is scoped narrowly to the file(s) cited; no broad refactors. Each task lists the exact file, the defect summary, and the conceptual fix approach (no source code). Tests must accompany every behavior change.

---

## Implementation Plan

### Tranche A — Critical (data-at-rest, authorization, timing)

- [x] Task A1. **Fail-closed on encryption errors** in `src/lib/db/encryption.ts:125-132`. `encrypt()` currently returns bare plaintext when AES-GCM throws, silently persisting secrets in cleartext. Change the catch block to `throw` (or propagate a typed `EncryptionError`) and update every caller of `encrypt()` / `encryptConnectionFields()` to surface or quarantine the failure (no silent writes). Rationale: a transient crypto failure must never demote a row to plaintext-at-rest.

- [x] Task A2. **Restore legacy-salt fallback in `decrypt()`** in `src/lib/db/encryption.ts:143-198`. The doc comment promises auto-migration via legacy key; the implementation only tries the static key. Add a second decryption attempt using `getLegacyDynamicKey()` (the same function `migrateLegacyEncryptedString` uses), and when the legacy key succeeds, return the plaintext AND mark the row for re-encryption (either via a write-back side effect or a `migrationNeeded` flag exposed alongside the value). Rationale: closes the v3.7.8 regression (`recent_issues.jsonl` issue #9) where tokens encrypted by the health-check thread become undecryptable.

- [x] Task A3. **Migration sweep for legacy-encrypted rows.** Add a startup task (or extend the existing `migrationRunner.ts` post-migration hook) that iterates `provider_connections`, calls `migrateLegacyEncryptedString` on each encrypted field, and writes back when `updated === true`. Rationale: bounds the re-encryption work instead of relying on lazy migration through Task A2.

- [x] Task A4. **Reject client-supplied `_meta.scopes` in MCP scope enforcement** in `open-sse/mcp-server/scopeEnforcement.ts:72-97`. Remove the `extractMetaScopeList(extra?._meta)` fallback OR restrict it to `_meta.omniroute.serverIssuedScopes` only — i.e., a server-set sub-namespace cryptographically signed at issuance. Document that `_meta.scopes` is client-controlled and must never grant scopes. Add unit tests proving a request with `_meta: { scopes: ["*"] }` and empty `authInfo.scopes` resolves to `{ scopes: [], source: "none" }`. Rationale: privilege-escalation vector for any transport where `authInfo` is empty (stdio, anonymous SSE).

- [ ] Task A5. **Constant-time env-key comparison** in `src/sse/services/auth.ts:1725-1733` and `src/lib/db/apiKeys.ts:171-174`. Replace `apiKey === envKey` / `key === envKey` with `crypto.timingSafeEqual`, gating on equal length first (with a dummy compare on length mismatch to keep total work uniform). Pattern already exists at `src/app/api/oauth/[provider]/[action]/route.ts:54` — reuse it as a shared helper in `src/lib/util/secureCompare.ts` (new file is acceptable here because the helper is referenced from multiple modules). Rationale: removes the network-observable timing oracle on the passthrough env-var key.

- [ ] Task A6. **Plan plaintext-key column retirement** in `src/lib/db/apiKeys.ts:265-269`. Split into two sub-steps so the runtime never breaks:
  - [ ] A6.a. Add a migration (`db/migrations/056_api_keys_hash_only.sql`) that backfills `key_hash` for any row still missing it (hash the existing `key` value), then clears `api_keys.key` to NULL when `key_hash IS NOT NULL`.
  - [ ] A6.b. Change `_stmtValidateKey` and `_stmtGetKeyMetadata` to `WHERE key_hash = ?` only; pass only `hashedKey` from `validateApiKey()` (line 818) and `getApiKeyMetadata()`. Keep the legacy `WHERE key = ?` clause behind a `OMNIROUTE_LEGACY_PLAINTEXT_KEYS=1` env flag for one release if backwards compatibility is needed.
  - Rationale: a DB leak today exposes every legacy key directly; the migration brings storage-at-rest in line with hash-only design.

### Tranche B — High (OAuth correctness, API surface, fail-open)

- [ ] Task B1. **Wire AbortController through `withTimeout`** in `open-sse/services/tokenRefresh.ts:1239-1257`. Refactor `withTimeout` to accept an `AbortSignal` factory or to pass an `AbortController` into `fn`. Update all callers (`refreshWithRetry`, every `refresh*Token` helper) so the timeout actually cancels the underlying `fetch`. Rationale: prevents orphan OAuth refreshes from consuming rotating one-time-use refresh tokens on Codex/OpenAI/Qwen after the local timeout fires.

- [ ] Task B2. **Stop mutating shared `credentials` in stale-token branch** in `open-sse/services/tokenRefresh.ts:1031-1034`. Replace the in-place mutation with a local shadow: bind a new `credentials = { ...credentials, refreshToken: dbConnection.refreshToken, accessToken: dbConnection.accessToken }` before calling `_getAccessTokenInternal`. Add a regression test that asserts the caller's original object is not modified after a stale-token path runs. Rationale: avoids cross-request token bleeding when callers share a cached credentials reference.

- [ ] Task B3. **Fix `responses/route.ts` CORS preflight** in `src/app/api/v1/responses/route.ts:12-19`. Replace the hand-rolled `OPTIONS` handler with `handleCorsOptions()` from `@/shared/utils/cors`. Rationale: brings the route's allowed methods/headers in line with the canonical CORS contract relied on by the middleware.

- [ ] Task B4. **Make prompt-injection guard flags propagate** in `src/middleware/promptInjectionGuard.ts:82-85`. Stop mutating the immutable `Request.headers`. Replace with one of:
  - [ ] B4.a. Attach the flag to an `AsyncLocalStorage` request-scoped context that downstream handlers read explicitly, OR
  - [ ] B4.b. Return the flag from `withInjectionGuard` and have the wrapped handler receive it as a second argument.
  - Update downstream consumers (search the codebase for `X-Injection-Flagged` / `X-Injection-Detections` — likely none, which means this entire side-channel can be deleted instead).
  - Rationale: today the flag never reaches the handler; the code is dead.

- [ ] Task B5. **Switch prompt-injection guard to fail-open** in `src/middleware/promptInjectionGuard.ts:87-93`. On internal guard error, log via the project logger (not `console.error`) and call the original `handler(request, context)` instead of returning HTTP 500. Add a unit test where `evaluatePromptInjection` throws and assert the handler is still invoked. Rationale: aligns the implementation with `docs/security/GUARDRAILS.md` (fail-open policy) and prevents a guard regression from globally bricking `/v1/chat/completions`.

- [ ] Task B6. **Validate token-refresh response payloads** in every refresh helper inside `open-sse/services/tokenRefresh.ts` (`refreshAccessToken`, `refreshClaudeOAuthToken`, `refreshCodexToken`, `refreshQwenToken`, `refreshQoderToken`, `refreshGitHubToken`, `refreshCopilotToken`, `refreshClineToken`, `refreshKimiCodingToken`, `refreshKiroToken`, `refreshWindsurfToken`). Before returning, assert `accessToken` (or provider-equivalent) is a non-empty string; otherwise return `null` with a structured log entry. Rationale: prevents persisting `accessToken: undefined`, which masquerades as a successful refresh and immediately fails downstream.

- [ ] Task B7. **Guard generic `_getAccessTokenInternal` against missing config** in `open-sse/services/tokenRefresh.ts:829-885`. For the `gemini` / `gemini-cli` / `antigravity` switch cases, return `null` (with a warn log) when `PROVIDERS[provider]` is undefined, instead of allowing a TypeError on `.clientId`. Reuse the pattern from `refreshAccessToken` (line 56). Rationale: removes a circuit-breaker false-positive on misconfiguration.

- [ ] Task B8. **Stop sending `client_secret` to public OAuth clients** in `open-sse/services/tokenRefresh.ts:67-72`. The generic `refreshAccessToken` should only append `client_secret` when `PROVIDERS[provider].oauthClientType === "confidential"` (introduce this flag in `src/shared/constants/providers.ts`). Public/PKCE clients should send only `client_id`. Rationale: prevents `invalid_client` rejections that needlessly trip the circuit breaker.

### Tranche C — Medium / Low (resource hygiene, hardening, perf)

- [ ] Task C1. **Clear abort timer on complete-after-disconnect** in `open-sse/utils/streamHandler.ts:107-117`. When `handleComplete()` runs while `disconnected === true`, still call `clearTimeout(abortTimeout)` before the early return. Rationale: eliminates a stray `abortController.abort()` ~2 s after the stream has already finished.

- [ ] Task C2. **Remove dead `pipeWithDisconnect` fake-writable** in `open-sse/utils/streamHandler.ts:218-228`. Either:
  - [ ] C2.a. Drop the synthetic `{ writable: { getWriter: () => ({ abort: () => {} }) } }` and refactor `createDisconnectAwareStream` to accept a `ReadableStream` plus a separate optional writer, OR
  - [ ] C2.b. Replace `pipeWithDisconnect` with a direct `providerResponse.body.pipeThrough(transformStream)` plus a `tee`/cancel-aware reader.
  - Rationale: makes the disconnect-cleanup contract explicit and removes the misleading no-op API.

- [ ] Task C3. **Cache negative API-key validations** in `src/lib/db/apiKeys.ts:802-843`. After `if (!row) return false;` (line 820) and after each "not active / banned / expired" branch, write `{valid: false, timestamp: now}` to `_keyValidationCache` with a short TTL (5–10 s). Make sure `invalidateCaches()` continues to clear negative entries on key create/update. Rationale: stops every brute-force / scanner request from hitting the DB.

- [ ] Task C4. **Batch bulk deletes** in `src/lib/usage/callLogs.ts:429-434` and `src/lib/db/providers.ts:444`. Wrap the `DELETE … WHERE id IN (…)` calls in a chunk loop of e.g., 500 ids per statement, inside a single transaction. Rationale: avoids `too many SQL variables` once cleanup queues grow beyond the SQLite parameter limit.

- [ ] Task C5. **De-duplicate `mergeAbortSignals` listeners** in `open-sse/executors/base.ts:153-173`. When one input aborts, explicitly call `removeEventListener` on the other. Rationale: avoids long-lived listeners on the surviving signal when one source is short-lived.

- [ ] Task C6. **Validate combo weighted-fallback selection** in `open-sse/services/combo.ts:560-571`. When `selected === undefined`, log a `warn` with `selectedExecutionKey` and the available `targets[].executionKey`, then return `rest` (sorted) instead of silently filtering. Rationale: surfaces combo reconfiguration races instead of dropping the intended head target.

- [ ] Task C7. **Replace PBKDF2 cache-key derivation with SHA-256** in `open-sse/services/tokenRefresh.ts:38-41`. The function derives an in-memory cache key, not a credential; swap to `createHash("sha256").update(provider).update(refreshToken).digest("hex")`. Rationale: ~1 ms CPU per refresh saved with no security loss (since the salt is a hardcoded constant).

- [ ] Task C8. **De-duplicate the prompt-injection guard** in `src/app/api/v1/chat/completions/route.ts:46-67`. Now that `handleChat` runs `guardrailRegistry.runPreCallHooks` (which already includes prompt-injection evaluation), delete the route-level guard or keep only one of the two. Recommend keeping the registry path so all routes (`/v1/responses`, etc.) get equal coverage. Rationale: removes a wasteful double-evaluation.

- [ ] Task C9. **Document IV-length policy** in `src/lib/db/encryption.ts:31`. Leave `IV_LENGTH = 16` for backward compatibility (changing it invalidates all existing ciphertexts), but add a code comment noting NIST SP 800-38D recommends 12 bytes and flagging the value for a future major-version migration. Rationale: no immediate action required, but the next major version should plan for it.

### Tranche D — Test & Verification Coverage

- [ ] Task D1. **Unit tests for encryption auto-migration**: extend `tests/unit/` with cases that (a) round-trip with the static key, (b) decrypt a fixture encrypted with the legacy dynamic salt and assert success, (c) assert `encrypt()` throws on key failure (post-A1).

- [ ] Task D2. **Unit tests for `evaluateToolScopes`**: assert that an empty `authInfo.scopes` plus a `_meta.scopes: ["*"]` payload resolves to `{ allowed: false, source: "none" or "env" }` after Task A4. Tests live under `tests/unit/` or `vitest` MCP suite.

- [ ] Task D3. **Timing-safe comparison tests**: assert `isValidApiKey` rejects keys differing only in the final character with identical wall-clock cost (statistical/best-effort) AND that the path uses `timingSafeEqual` (mock spy).

- [ ] Task D4. **Token-refresh AbortController test**: create a mock `fetch` that never resolves; assert `withTimeout` fires its abort signal and the mock `fetch` receives an `AbortError`.

- [ ] Task D5. **Stream-handler regression tests**: cover the disconnect-then-complete sequence and assert the abort timer is cleared.

- [ ] Task D6. **Negative-validation cache test**: assert two consecutive `validateApiKey("wrong-key")` calls produce exactly one DB query.

- [ ] Task D7. **Add `node --import tsx/esm --test` to PR gate** for every new test file. Also run `npm run check` and `npm run check:cycles`.

### Tranche E — Release & Rollout

- [ ] Task E1. **Update `CHANGELOG.md`** with one entry per fix grouped by severity. Reference the originating issue ids in `recent_issues.jsonl` where applicable (notably issue #9 for Task A2).

- [ ] Task E2. **Run the full test matrix**: `npm run test:all`, `npm run test:vitest`, `npm run test:protocols:e2e`, `npm run test:ecosystem`.

- [ ] Task E3. **Tag tranche-A as a security-patch release** (`vX.Y.Z+1` patch) so downstream operators can pull it without taking on the OAuth refactors in Tranche B. Tranches B/C/D ride a normal minor release.

---

## Verification Criteria

- Every domain-module change has at least one accompanying test under `tests/unit/` or `tests/integration/`, and the suite passes via `npm run test:all`.
- `npm run lint` and `npm run typecheck:core` exit clean on the patched tree.
- A legacy-encrypted token fixture from v3.7.7 successfully decrypts and is auto-re-encrypted by Task A2 + Task A3 (assert via a focused integration test using a temp SQLite DB).
- `_meta.scopes: ["*"]` from a stdio MCP client with empty `authInfo` is rejected for any tool requiring a scope (Task A4 regression test).
- A burst of 1 000 invalid API keys produces ≤ 1 000 DB queries before caching and ≤ 1 query/key after caching (Task C3 — measured via prepared-statement spy).
- Killing `withTimeout` on a refresh aborts the upstream `fetch` and propagates an `AbortError` (Task B1 regression test).
- `OPTIONS /v1/responses` now returns the same headers as `OPTIONS /v1/chat/completions` (Task B3 — snapshot test).
- Throwing inside `evaluatePromptInjection` no longer returns HTTP 500 from `/v1/chat/completions` (Task B5 regression test).
- `recent_issues.jsonl` issue #9 (encryption re-encryption loop) is verifiably closed: a process running the patched build with a v3.7.8-shaped DB does not enter the CPU-spike pattern (manual repro check).

---

## Potential Risks and Mitigations

1. **Risk: Task A1 (fail-closed encryption) breaks startup if `STORAGE_ENCRYPTION_KEY` is malformed at runtime.**
   Mitigation: keep the existing `validateEncryptionConfig()` check at boot (already present at lines 239-267). If it fails, refuse to start with an actionable error rather than running and silently writing plaintext. The runtime `encrypt()` then throws only on genuine crypto faults, which are extremely rare.

2. **Risk: Task A6 (plaintext-key column retirement) locks out customers who still authenticate against the legacy `key` column.**
   Mitigation: ship the migration (A6.a) one release ahead of the validator change (A6.b). Behind `OMNIROUTE_LEGACY_PLAINTEXT_KEYS=1`, allow one more release of dual lookup. Document the deprecation in `CHANGELOG.md`.

3. **Risk: Task B1 (AbortController in `withTimeout`) regresses behavior for callers that pass async functions not expecting cancellation.**
   Mitigation: thread the `AbortSignal` strictly into the `fetch` call inside each `refresh*Token` helper and leave the surrounding helper logic untouched. All helpers already await a single `fetch` call, so the blast radius is bounded.

4. **Risk: Task B4 (header propagation rewrite) breaks downstream consumers of `X-Injection-Flagged`.**
   Mitigation: codebase search confirms no consumer reads that header today (verify before deleting). If any are found post-search, plumb through `AsyncLocalStorage` instead.

5. **Risk: Task A4 (MCP scope tightening) breaks legitimate clients that today set `_meta.scopes`.**
   Mitigation: ship a one-release deprecation warning that logs `[MCP] _meta.scopes is ignored; configure scopes via authInfo or env`. Cross-check `docs/frameworks/MCP-SERVER.md` for any guidance instructing clients to set `_meta.scopes` and update accordingly.

6. **Risk: Tranche-A fixes land in a security-patch release that omits Tranche B/C, leaving rotating-token refresh races unfixed.**
   Mitigation: release Tranche A only with a clear note that Tranche B follows in the next minor; document the OAuth-refresh race as a known issue in the security advisory accompanying the patch.

---

## Alternative Approaches

1. **Big-bang single PR for all tranches.** Pros: one merge, one release. Cons: harder to review, harder to revert, blocks the security patch behind unrelated OAuth changes. Not recommended.

2. **Defer Task A2 in favor of a one-shot offline re-encryption migration.** Pros: simpler `decrypt()`. Cons: any newly-written legacy-encrypted row (from a hot-running v3.7.8 process during the upgrade) will still fail until the migration runs. The hybrid in this plan (A2 runtime-fallback + A3 startup sweep) handles both cases.

3. **Replace the entire `withTimeout` helper with `AbortSignal.timeout(ms)`** (Node 18.17+ / 20 stable). Pros: idiomatic, less code. Cons: it doesn't compose with the existing `mergeAbortSignals` path and Node 20.20.2 (`engines` floor) is the minimum, where compat is fine — but it changes the surface area enough to warrant a follow-up rather than bundling with Task B1. Recommend revisiting in a future cleanup.

4. **Move scope enforcement into the MCP transport layer** rather than fixing it in `scopeEnforcement.ts`. Pros: cleaner separation of concerns. Cons: bigger refactor, touches stdio/SSE/streamable-http transports, blocks the security fix. Defer; Task A4 is the minimal targeted patch.

---

## Handoff Notes for the Forge Agent

- **Order of execution**: A1 → A2 → A3 → A4 → A5 → A6 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → C1..C9 → D1..D7 → E1..E3.
- **Commit granularity**: one task per commit; one tranche per PR. Each PR includes the relevant `D*` tests.
- **Required pre-merge checks**: `npm run lint`, `npm run typecheck:core`, `npm run typecheck:noimplicit:core`, `npm run check:cycles`, `npm run test:all`, `npm run test:vitest`.
- **Code-style reminders**: 2-space indent, double quotes, semicolons required, 100-char width (project guidelines). All new files in `src/` use TypeScript; `open-sse/` keeps its JS/TS hybrid conventions.
- **Do NOT** touch `src/lib/localDb.ts` except as a pure re-export.
- **Do NOT** introduce raw SQL inside route handlers; route through `src/lib/db/*` modules.
- **Citation format for PR descriptions**: use `filepath:startLine-endLine` per the project rules.

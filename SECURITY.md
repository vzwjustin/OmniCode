# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in OmniRoute, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Use [GitHub Security Advisories](https://github.com/diegosouzapw/OmniRoute/security/advisories/new)
3. Include: description, reproduction steps, and potential impact

## Response Timeline

| Stage               | Target                      |
| ------------------- | --------------------------- |
| Acknowledgment      | 48 hours                    |
| Triage & Assessment | 5 business days             |
| Patch Release       | 14 business days (critical) |

## Supported Versions

| Version | Support Status |
| ------- | -------------- |
| 3.6.x   | ✅ Active      |
| 3.5.x   | ✅ Security    |
| < 3.5.0 | ❌ Unsupported |

---

## Security Architecture

OmniRoute implements a multi-layered security model:

```
Request → CORS → API Key Auth → Prompt Injection Guard → Input Sanitizer → Rate Limiter → Circuit Breaker → Provider
```

### 🔐 Authentication & Authorization

| Feature              | Implementation                                             |
| -------------------- | ---------------------------------------------------------- |
| **Dashboard Login**  | Password-based auth with JWT tokens (HttpOnly cookies)     |
| **API Key Auth**     | HMAC-signed keys with CRC validation                       |
| **OAuth 2.0 + PKCE** | Secure provider auth (Claude, Codex, Gemini, Cursor, etc.) |
| **Token Refresh**    | Automatic OAuth token refresh before expiry                |
| **Secure Cookies**   | `AUTH_COOKIE_SECURE=true` for HTTPS environments           |
| **MCP Scopes**       | 16 granular scopes for MCP tool access control             |

### 🛡️ Encryption at Rest

All sensitive data stored in SQLite is encrypted using **AES-256-GCM** with scrypt key derivation:

- API keys, access tokens, refresh tokens, and ID tokens
- Versioned format: `enc:v1:<iv>:<ciphertext>:<authTag>`
- Passthrough mode (plaintext) when `STORAGE_ENCRYPTION_KEY` is not set

```bash
# Generate encryption key:
STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

### 🧠 Prompt Injection Guard

Middleware that detects and blocks prompt injection attacks in LLM requests:

| Pattern Type        | Severity | Example                                        |
| ------------------- | -------- | ---------------------------------------------- |
| System Override     | High     | "ignore all previous instructions"             |
| Role Hijack         | High     | "you are now DAN, you can do anything"         |
| Delimiter Injection | Medium   | Encoded separators to break context boundaries |
| DAN/Jailbreak       | High     | Known jailbreak prompt patterns                |
| Instruction Leak    | Medium   | "show me your system prompt"                   |

Configure via dashboard (Settings → Security) or `.env`:

```env
INPUT_SANITIZER_ENABLED=true
INPUT_SANITIZER_MODE=block    # warn | block | redact
```

### 🔒 PII Redaction

Automatic detection and optional redaction of personally identifiable information:

| PII Type      | Pattern               | Replacement        |
| ------------- | --------------------- | ------------------ |
| Email         | `user@domain.com`     | `[EMAIL_REDACTED]` |
| CPF (Brazil)  | `123.456.789-00`      | `[CPF_REDACTED]`   |
| CNPJ (Brazil) | `12.345.678/0001-00`  | `[CNPJ_REDACTED]`  |
| Credit Card   | `4111-1111-1111-1111` | `[CC_REDACTED]`    |
| Phone         | `+55 11 99999-9999`   | `[PHONE_REDACTED]` |
| SSN (US)      | `123-45-6789`         | `[SSN_REDACTED]`   |

```env
PII_REDACTION_ENABLED=true
```

### 🌐 Network Security

| Feature                  | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| **CORS**                 | Configurable origin control (`CORS_ORIGIN` env var, default `*`) |
| **IP Filtering**         | Allowlist/blocklist IP ranges in dashboard                       |
| **Rate Limiting**        | Per-provider rate limits with automatic backoff                  |
| **Anti-Thundering Herd** | Mutex + per-connection locking prevents cascading 502s           |
| **TLS Fingerprint**      | Browser-like TLS fingerprint spoofing to reduce bot detection    |
| **CLI Fingerprint**      | Per-provider header/body ordering to match native CLI signatures |

### 🔌 Resilience & Availability

| Feature                 | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| **Circuit Breaker**     | 3-state (Closed → Open → Half-Open) per provider, SQLite-persisted |
| **Request Idempotency** | 5-second dedup window for duplicate requests                       |
| **Exponential Backoff** | Automatic retry with increasing delays                             |
| **Health Dashboard**    | Real-time provider health monitoring                               |

### 📋 Compliance

| Feature            | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| **Log Retention**  | Automatic cleanup after `CALL_LOG_RETENTION_DAYS`           |
| **No-Log Opt-out** | Per API key `noLog` flag disables request logging           |
| **Audit Log**      | Administrative actions tracked in `audit_log` table         |
| **MCP Audit**      | SQLite-backed audit logging for all MCP tool calls          |
| **Zod Validation** | All API inputs validated with Zod v4 schemas at module load |

---

## Required Environment Variables

All secrets must be set before starting the server. The server will **fail fast** if they are missing or weak.

```bash
# REQUIRED — server will not start without these:
JWT_SECRET=$(openssl rand -base64 48)     # min 32 chars
API_KEY_SECRET=$(openssl rand -hex 32)    # min 16 chars

# RECOMMENDED — enables encryption at rest:
STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

The server actively rejects known-weak values like `changeme`, `secret`, or `password`.

---

## Bootstrap API Key

OmniRoute supports a single, environment-supplied **bootstrap API key** read
from the `OMNIROUTE_API_KEY` variable (legacy alias: `ROUTER_API_KEY`). This
key is intentionally privileged so that operators always have a way to
recover the dashboard and call internal endpoints (MCP, A2A, sync jobs) even
if the SQLite database is wiped or corrupted.

### Trust model

- `OMNIROUTE_API_KEY`, when set, is treated as **authenticated with `manage`
  scope** for every request that presents it.
- It is **not stored in the database** and therefore **cannot be revoked,
  rotated, or audited from the Dashboard UI**. Revocation requires unsetting
  the env var (or rotating its value) and restarting the process.
- It is the only credential that can bootstrap a freshly-provisioned instance
  with no DB-stored keys, so it should be treated like a root password.

### Operational guidance

1. Generate a strong value: `openssl rand -hex 32`.
2. Inject it only via the process environment (systemd `EnvironmentFile`,
   Docker `-e`, Kubernetes `Secret`) — **never** check it into git or write
   it to `.env` files that ship in images.
3. Prefer DB-stored API keys created from the Dashboard (`Dashboard →
Settings → API Keys`) for application/agent traffic. They are
   per-purpose, revocable, and auditable.
4. Rotate `OMNIROUTE_API_KEY` periodically: update the env var to a new
   random value and restart the server. Any clients pinned to the old value
   will get `401` immediately.
5. If you suspect compromise, rotate the value immediately and review
   `mcp_audit` / request logs for unexpected calls during the exposure
   window.

### When to leave it unset

For multi-tenant or production deployments where bootstrap recovery is
handled out of band (e.g. via direct DB access on a bastion host), it is
safe — and recommended — to leave `OMNIROUTE_API_KEY` **unset** and rely
exclusively on DB-stored API keys plus password-authenticated dashboard
sessions.

---

## Docker Security

- Use non-root user in production
- Mount secrets as read-only volumes
- Never copy `.env` files into Docker images
- Use `.dockerignore` to exclude sensitive files
- Set `AUTH_COOKIE_SECURE=true` when behind HTTPS

```bash
docker run -d \
  --name omniroute \
  --restart unless-stopped \
  --read-only \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e API_KEY_SECRET="$(openssl rand -hex 32)" \
  -e STORAGE_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  diegosouzapw/omniroute:latest
```

---

## Dependencies

- Run `npm audit` regularly
- Keep dependencies updated
- The project uses `husky` + `lint-staged` for pre-commit checks
- CI pipeline runs ESLint security rules on every push
- Provider constants validated at module load via Zod (`src/shared/validation/providerSchema.ts`)

# local-openrouter-fusion

A small, production-minded FastAPI service that **fuses multiple OpenRouter
models locally**. You send one prompt; the service fans it out to several
models in parallel, optionally runs a critique pass, then synthesizes the
results through a judge model and returns **one fused answer**.

It is **not** a wrapper around OpenRouter's native fusion alias, plugin, or
server tool. Everything happens locally:

```
your client ──▶ local-openrouter-fusion (FastAPI)
                      │
                      ├── POST /chat/completions ──▶ OpenRouter (model A)
                      ├── POST /chat/completions ──▶ OpenRouter (model B)   ─┐
                      ├── POST /chat/completions ──▶ OpenRouter (model C)    │ parallel
                      ├── (optional) POST /chat/completions ─▶ critic model ─┘
                      └── POST /chat/completions ──▶ OpenRouter (judge)
                                                       │
                                                       ▼
                                              ONE fused answer
```

## How it differs from OpenRouter's native fusion

- ❌ No `model: "openrouter/fusion"` alias.
- ❌ No `plugins: [{ "id": "fusion" }]`.
- ❌ No `tools: [{ "type": "openrouter:fusion" }]` server tool.
- ✅ Every call is a regular `POST /chat/completions` to OpenRouter with a
  concrete model id you control.
- ✅ Fan-out, critique, and synthesis happen in this service.

## Setup

```bash
git clone <this repo>
cd local-openrouter-fusion
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY + SERVICE_API_KEYS
uvicorn app.main:app --reload --port 8000
```

Sanity check:

```bash
curl http://localhost:8000/health
# {"status":"operational","mode":"local-fusion-orchestration","native_openrouter_fusion":false}
```

## Environment

See [`.env.example`](./.env.example) for the full list. Key vars:

| Var                              | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `OPENROUTER_API_KEY`             | Your OpenRouter API key (required).                        |
| `SERVICE_API_KEYS`               | CSV of local API keys this service will accept.            |
| `DEFAULT_ANALYSIS_MODELS`        | CSV of analysis model ids used when caller omits them.     |
| `DEFAULT_JUDGE_MODEL`            | Final synthesis model.                                     |
| `DEFAULT_CRITIC_MODEL`           | Optional critique model.                                   |
| `ALLOWED_MODELS`                 | Optional CSV whitelist. Empty = allow any model id.        |
| `RATE_LIMIT_CAPACITY`            | Token-bucket size per local key.                           |
| `RATE_LIMIT_REFILL_PER_MINUTE`   | Steady refill rate (tokens / minute).                      |
| `LOCAL_TOKEN_BUDGET_PER_KEY`     | Per-key OpenRouter-token budget (0 = unlimited).           |
| `CACHE_TTL_SECONDS`              | In-memory response cache TTL.                              |
| `MAX_ANALYSIS_MODELS`            | Hard cap on parallel analysis models.                      |
| `MAX_MODEL_CONCURRENCY`          | Asyncio semaphore for upstream calls.                      |

## API

### `GET /health`

```json
{
  "status": "operational",
  "mode": "local-fusion-orchestration",
  "native_openrouter_fusion": false
}
```

### `POST /v1/fuse` (native)

Auth: `Authorization: Bearer <SERVICE_API_KEY>` (or `X-API-Key: <key>`).

Request:

```json
{
  "messages": [
    {"role": "system", "content": "optional system instructions"},
    {"role": "user", "content": "actual user task"}
  ],
  "analysis_models": [
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4.1",
    "google/gemini-2.5-pro"
  ],
  "judge_model": "anthropic/claude-opus-4.1",
  "critic_model": "anthropic/claude-sonnet-4.5",
  "mode": "balanced",
  "temperature": 0.2,
  "max_tokens": 4000,
  "include_candidates": false,
  "include_trace": false,
  "enable_critique": true,
  "enable_cache": true
}
```

Response (default, `include_candidates=false`):

```json
{
  "answer": "single final fused answer",
  "meta": {
    "analysis_models": ["..."],
    "judge_model": "...",
    "critic_model": "...",
    "mode": "balanced",
    "cached": false,
    "usage": { "total_tokens": 12345 },
    "latency_ms": 12345,
    "judge_failed": false,
    "critic_failed": false,
    "fallback_reason": null
  }
}
```

With `include_candidates=true`, the response additionally contains a
`candidates: [...]` array (per-model content, finish_reason, usage,
latency, error) and a `critique` string.

### Modes

| Mode       | Behavior                                                              |
| ---------- | --------------------------------------------------------------------- |
| `fast`     | No critique; judge synthesizes directly. Lower latency.               |
| `balanced` | Default. Independent analysis + optional critique + judge synthesis.  |
| `deep`     | Critic identifies disagreements / risks; judge resolves contradictions. |
| `code`     | Implementation-ready output; judge produces a build-ready plan.       |

## OpenAI-compatible endpoint (use from Claude Code / curl / any OpenAI client)

Drop-in compatible with any OpenAI-style client. Point your client at
`http://localhost:8000/v1` and set the model to one of the fusion aliases:

- `local-fusion` (balanced)
- `local-fusion-fast`
- `local-fusion-balanced`
- `local-fusion-deep`
- `local-fusion-code`

Inline model config is also supported in the `model` field:

```
local-fusion-code:anthropic/claude-sonnet-4.5+openai/gpt-4.1@anthropic/claude-opus-4.1
                  └──────── analysis models ────────────────┘  └─── judge ────────────┘
```

Endpoints:

- `GET /v1/models` → lists the `local-fusion*` model ids.
- `POST /v1/chat/completions` → standard OpenAI shape in/out. Supports `stream: true`
  (emits a single fused assistant chunk + `[DONE]`).

### curl example (native)

```bash
curl -X POST http://localhost:8000/v1/fuse \
  -H "Authorization: Bearer local-secret-key-1" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "code",
    "messages": [
      {
        "role": "user",
        "content": "Audit this repo for broken wiring, missing features, incomplete stubs, bugs, and security issues. Return a direct implementation plan."
      }
    ],
    "analysis_models": [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro"
    ],
    "judge_model": "anthropic/claude-opus-4.1",
    "temperature": 0.2,
    "max_tokens": 6000,
    "include_candidates": false,
    "enable_critique": true
  }'
```

### curl example (OpenAI-compatible)

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer local-secret-key-1" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-fusion-code",
    "messages": [
      {"role": "user", "content": "Write a production-grade Python rate limiter."}
    ],
    "temperature": 0.2,
    "max_tokens": 4000
  }'
```

### Configuration UI (the "custom LLM" pattern)

Open `http://localhost:8000/` in a browser. The dashboard lets you set the
**default** fusion behavior the proxy uses for every incoming
`/v1/chat/completions` request:

- Analysis models (mix `local:*` and remote OpenRouter ids freely)
- Judge model
- Critic model + critique on/off
- Mode (fast / balanced / deep / code)
- Temperature, max_tokens, cache toggle
- Quick presets: fully-local, local→remote judge, remote default, code-heavy

Saving the config writes to the runtime store (persisted to
`LOCAL_FUSION_CONFIG_PATH`, defaults to `./fusion_config.json`) and is
applied immediately to incoming requests. The UI also has a test panel that
fires a sample prompt through `/v1/chat/completions` — exactly the path
your editor/CLI will take — so you can sanity-check the setup.

**The custom-LLM pattern:** point Claude Code, Codex, or your IDE at this
service with model `local-fusion`. The calling tool sends a normal OpenAI
chat completion request; the proxy runs your configured fusion server-side
and returns a single fused answer in the standard OpenAI response shape.
The calling tool never knows fusion happened.

Admin API (used by the UI, also callable directly):

```bash
# Read the current active config
curl http://localhost:8000/v1/admin/config \
  -H "Authorization: Bearer local-secret-key-1"

# Update it
curl -X PUT http://localhost:8000/v1/admin/config \
  -H "Authorization: Bearer local-secret-key-1" \
  -H "Content-Type: application/json" \
  -d '{
    "analysis_models": ["local:claude-code", "local:codex", "local:gemini"],
    "judge_model": "anthropic/claude-opus-4.1",
    "mode": "code",
    "enable_critique": true
  }'
```

Resolution order for each fusion field on `/v1/chat/completions`:

1. Explicit field in the request body (e.g. `judge_model`) — highest priority.
2. Inline model-name parsing (e.g. `local-fusion-code:m1+m2@judge`).
3. Runtime ActiveConfig (what the UI sets).
4. `Settings` defaults from `.env` — lowest priority.

### Claude Code usage

Claude Code accepts any OpenAI-compatible base URL + key. Set:

```
ANTHROPIC_BASE_URL or OPENAI_BASE_URL   http://localhost:8000/v1
ANTHROPIC_API_KEY  or OPENAI_API_KEY    local-secret-key-1
model                                   local-fusion-code
```

Then everything Claude Code sends goes through the local fusion brain. To
control the fusion behavior per-request without changing the model, use the
extra request fields (Pydantic accepts them on the OpenAI-compat endpoint):

```json
{
  "model": "local-fusion-code",
  "messages": [...],
  "analysis_models": ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
  "judge_model": "anthropic/claude-opus-4.1",
  "enable_critique": true,
  "include_candidates": false
}
```

## Local CLI models (Claude Code, Codex, Gemini)

You can mix locally-installed CLI assistants into the fusion alongside (or
instead of) OpenRouter models. Three adapters are built in:

| Model id            | Built-in command env var            |
| ------------------- | ----------------------------------- |
| `local:claude-code` | `LOCAL_CLAUDE_CODE_CMD` + `…_ARGS`  |
| `local:codex`       | `LOCAL_CODEX_CMD` + `…_ARGS`        |
| `local:gemini`      | `LOCAL_GEMINI_CMD` + `…_ARGS`       |

An adapter is **disabled** unless its `CMD` env var is set. The prompt is
flattened from the chat messages and **written on stdin** to the CLI — we
never use `shell=True` and never interpolate prompts into argv strings, so
caller input cannot escape into shell metacharacters.

`local:` model ids are valid anywhere an `analysis_models` / `judge_model` /
`critic_model` value is accepted, including inside the OpenAI-compat inline
model name:

```
local-fusion-code:local:claude-code+local:codex+local:gemini@anthropic/claude-opus-4.1
                  └──────────── 3 local analysis models ────┘  └──── remote judge ───┘
```

### Pattern: local analysis → remote judge → local API output

```json
{
  "model": "local-fusion-code",
  "messages": [{"role": "user", "content": "..."}],
  "analysis_models": ["local:claude-code", "local:codex", "local:gemini"],
  "judge_model": "anthropic/claude-opus-4.1"
}
```

Three local CLIs run in parallel, each produces its own draft, then a single
remote OpenRouter call synthesizes the final answer.

### Pattern: fully local (skip OpenRouter)

```json
{
  "model": "local-fusion-balanced",
  "messages": [{"role": "user", "content": "..."}],
  "analysis_models": ["local:claude-code", "local:codex"],
  "judge_model": "local:gemini",
  "enable_critique": false
}
```

No remote calls happen at all — every leg is a local subprocess. You can
even leave `OPENROUTER_API_KEY` unset in this mode; the service only
validates it when an OpenRouter call is actually about to be made.

## Failure semantics

- **One analysis model fails** → recorded in the per-model candidate record;
  the rest of the run continues.
- **All analysis models fail** → `502 all_analysis_models_failed`.
- **Judge fails** → fall back to the most detailed candidate, return the
  fused answer with `meta.judge_failed=true` and `meta.fallback_reason`.
- **Upstream 401 / 402 / 429 / 5xx** → mapped to a clean local error; no raw
  upstream stack traces or payloads leak.

## Security notes

- Local auth uses `Authorization: Bearer …` or `X-API-Key`, compared with
  `secrets.compare_digest` against every configured key.
- Caller keys are hashed (SHA-256, truncated) before being used as the
  rate-limit / quota bucket id — raw keys never end up in logs or memory.
- All logs go through a redaction filter that masks `sk-or-v1-…`, `sk-…`,
  and `Authorization: Bearer …` substrings.
- The Pydantic models reject unknown fields (`extra="forbid"`).
- Prompt length is hard-capped via `MAX_PROMPT_CHARS`.
- Upstream errors are sanitized; raw stack traces are never returned.

## Cost warning

Fusion sends 1 request per analysis model + 1 optional critic + 1 judge.
For a 4-model balanced run with critique enabled that's **6 OpenRouter calls
per fuse**. Pick models and `max_tokens` accordingly. Use `mode: "fast"` and
`enable_critique: false` for cheap routing.

## Troubleshooting

- `401 Missing local API key` → set `SERVICE_API_KEYS` in `.env` and send
  `Authorization: Bearer <one of them>`.
- `500 Service has no SERVICE_API_KEYS configured` → same, but `.env` was
  loaded with empty value.
- `502 Upstream auth failed (OpenRouter 401)` → bad `OPENROUTER_API_KEY`.
- `429 Local rate limit exceeded` → bump `RATE_LIMIT_CAPACITY` /
  `RATE_LIMIT_REFILL_PER_MINUTE` in `.env`.
- `402 Local token budget exceeded` → bump or zero out
  `LOCAL_TOKEN_BUDGET_PER_KEY` (0 = unlimited).
- `400 Model(s) not in ALLOWED_MODELS` → either add them to
  `ALLOWED_MODELS` or empty that setting.
- Cache stuck on stale answer → set `enable_cache: false` per request or
  drop `CACHE_TTL_SECONDS`.

## Tests

```bash
pip install -r requirements.txt
pytest -q
```

Tests cover: schema rejection of unknown fields, auth (bearer + x-api-key),
rate limit math, log redaction, parallel orchestration with partial model
failure, all-models-fail returning 502, judge fallback to the best
candidate, cache hits, model whitelist enforcement, and the OpenAI-compat
endpoint (basic, inline-config model name, streaming, unknown model).

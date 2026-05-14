<div align="center">

# OmniCoder

### One endpoint. Every coding model. Auto-fallback when one dies.

A lean, hardened AI proxy purpose-built for coding tools — **Claude Code, Codex, Cursor, Cline, Gemini CLI, Aider, Kilo Code, GitHub Copilot, OpenClaw** — backed by 150+ chat providers, smart routing, prompt compression, and an MCP server.

[![Node](https://img.shields.io/badge/node-%3E%3D20.20.2-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/100%25-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## Why OmniCoder

Coding with one provider is fragile: quota expires, rate limits kick in mid-session, OAuth tokens drift, and no single provider has the best model for every job. OmniCoder sits between your editor and 150+ providers and routes around all of it.

- **One endpoint** — point any coding tool at `http://localhost:20128/v1` and you're done.
- **Auto-fallback** — Subscription → API Key → Cheap → Free, ordered by your combo.
- **Format translation** — OpenAI ↔ Anthropic ↔ Gemini ↔ Responses API. Use Claude Code with GPT, or Codex with Claude.
- **Prompt compression** — Caveman + RTK pipelines save 15-95% tokens with no quality loss for code.
- **OAuth handled for you** — Claude Code, Codex, Cursor, GitHub Copilot, Antigravity, Kimi Coding, Kilo Code, Cline. Auto-refresh, multi-account round-robin.
- **MCP server** — 37 tools over stdio/SSE/Streamable HTTP, 10 scopes.
- **No bloat** — chat, embeddings, web search, reranking, moderations. No image/video/music/audio generation, no vision bridge, no Redis dependency.

---

## Quick start

```bash
# Clone and install locally
git clone https://github.com/vzwjustin/OmniCode.git omnicoder
cd omnicoder
env -u NODE_ENV npm install
env -u NODE_ENV npm run build:cli
npm link

# Start it
omnicoder                     # default port 20128, opens dashboard
omnicoder --port 3001         # custom port
omnicoder --no-open           # don't open the browser
omnicoder --mcp               # stdio MCP server for IDE integration

# Helpers
omnicoder setup               # interactive guided setup
omnicoder doctor              # local health checks
omnicoder providers available # list every supported provider
omnicoder providers list      # list configured providers
```

Then point your coding tool at:

```
http://localhost:20128/v1
```

Data lives in `~/.omnicoder/` (or `~/.omniroute/` if you're upgrading from upstream — both paths are read, OmniCoder wins).

---

## Supported coding tools

Drop-in compatible with every major AI coding tool:

| Tool                  | Connection                                  |
| --------------------- | ------------------------------------------- |
| **Claude Code**       | `ANTHROPIC_BASE_URL=http://localhost:20128` |
| **Codex CLI**         | `OPENAI_BASE_URL=http://localhost:20128/v1` |
| **Cursor**            | OpenAI-compatible base URL                  |
| **Cline**             | OpenAI-compatible base URL                  |
| **Gemini CLI**        | Gemini base URL override                    |
| **GitHub Copilot**    | OAuth provider, no client config needed     |
| **Aider**             | `OPENAI_API_BASE=http://localhost:20128/v1` |
| **Kilo Code**         | OAuth provider                              |
| **OpenClaw**          | OpenAI-compatible base URL                  |
| **Continue.dev**      | OpenAI-compatible base URL                  |
| **Roo Code**          | OpenAI-compatible base URL                  |
| **Open WebUI**        | OpenAI-compatible base URL                  |
| **LibreChat**         | OpenAI-compatible base URL                  |
| **MCP-aware editors** | Native MCP integration (37 tools)           |

Full per-tool setup: [`docs/CLI-TOOLS.md`](docs/CLI-TOOLS.md).

---

## Providers (150+)

**OAuth (8):** Claude Code, Antigravity, Codex, GitHub Copilot, Cursor, Kimi Coding, Kilo Code, Cline.

**Free (10+):** Kiro AI (Claude Sonnet/Opus), Qoder AI (Kimi K2, DeepSeek R1), Qwen Code, Pollinations (GPT-5, Claude, Llama 4), LongCat, Cloudflare AI, Puter, NVIDIA NIM, Cerebras, Scaleway, Groq.

**API Key (120+):** OpenAI, Anthropic, Gemini, DeepSeek, Groq, xAI (Grok), Mistral, OpenRouter, GLM, Kimi, MiniMax, Fireworks, Together, Cerebras, Cohere, NVIDIA, Perplexity, SiliconFlow, Nebius, HuggingFace, DeepInfra, SambaNova, Vertex AI, Azure OpenAI, AWS Bedrock, Snowflake, Databricks, Venice, AI21, Meta Llama, plus ~90 more.

**Self-Hosted:** LM Studio, Ollama, vLLM, Llamafile, Docker Model Runner, NVIDIA Triton, XInference, oobabooga.

**Custom:** Any OpenAI-compatible or Anthropic-compatible endpoint via `openai-compatible-*` / `anthropic-compatible-*` prefixes.

Full list: `omnicoder providers available`.

---

## Combos (smart routing)

A combo is an ordered list of provider+model targets. When the first fails (quota, 429, 5xx, expired token), OmniCoder fails over to the next.

```
Combo: "my-coding-stack"
  1. cc/claude-opus-4-7        (Claude Code subscription)
  2. cx/gpt-5.5                (Codex subscription)
  3. glm/glm-5.1               (cheap backup — $0.5/1M)
  4. kr/claude-sonnet-4.5      (free unlimited via Kiro)

Strategy: priority         Compression: standard (caveman)
```

13 strategies available: priority, weighted, round-robin, P2C, fill-first, random, least-used, cost-optimized, strict-random, **auto** (6-factor scoring), **lkgp** (last-known-good prioritized), **context-optimized**, **context-relay** (cross-session handoff).

---

## Prompt compression

Save 15-95% tokens per request without losing code semantics. Compression pipelines:

| Mode         | What it does                                                                             | Typical savings       |
| ------------ | ---------------------------------------------------------------------------------------- | --------------------- |
| `lite`       | Whitespace collapse, system-prompt dedup, redundant content removal                      | 10-15%                |
| `standard`   | Lite + Caveman rules (filler removal, semantic condensation)                             | 25-40%                |
| `aggressive` | Standard + aggressive condensation                                                       | 40-55%                |
| `ultra`      | Maximum condensation, still preserves code blocks and identifiers                        | 60-75%                |
| `rtk`        | Command-output compression (`git diff`, `grep`, `ls`, test output) via JSON filter packs | 70-95% on tool output |
| `stacked`    | RTK then Caveman — strip command noise first, then semantic condense                     | 50-85% combined       |
| `off`        | Pass-through                                                                             | 0%                    |

Configure via dashboard → Compression, or per-combo override. Full details: [`docs/COMPRESSION_GUIDE.md`](docs/COMPRESSION_GUIDE.md), [`docs/RTK_COMPRESSION.md`](docs/RTK_COMPRESSION.md).

---

## MCP server (37 tools)

Native MCP server over **stdio**, **SSE**, and **Streamable HTTP**. Every tool is scoped — your IDE/agent only gets what you grant.

**Categories:** core routing (20), cache (2), compression (5), 1proxy (3), memory (3), skills (4).

```bash
# IDE integration (stdio)
omnicoder --mcp

# HTTP endpoints (after starting the server)
http://localhost:20128/api/mcp/sse        # SSE transport
http://localhost:20128/api/mcp/stream     # Streamable HTTP
```

Full details: [`open-sse/mcp-server/README.md`](open-sse/mcp-server/README.md).

---

## A2A protocol

JSON-RPC 2.0 + SSE streaming, full task lifecycle, agent discovery via `/.well-known/agent.json`. Built-in skills: smart routing, quota management. Custom skills can be registered.

Endpoint: `http://localhost:20128/a2a`. Full details: [`src/lib/a2a/README.md`](src/lib/a2a/README.md).

---

## Docker

```yaml
services:
  omnicoder:
    image: vzwjustin/omnicoder:latest # build locally for now
    ports: ["20128:20128"]
    volumes: ["omnicoder-data:/data"]
    environment:
      DATA_DIR: /data
    stop_grace_period: 40s

volumes:
  omnicoder-data:
```

No Redis. No external services required.

---

## What was stripped from upstream

This is a deliberately leaner fork. Removed entirely:

- **Image / video / music / audio generation** — `/v1/images/*`, `/v1/videos/*`, `/v1/music/*`, `/v1/audio/*`, plus 11 media-only providers (NanoBanana, RunwayML, ComfyUI, SD WebUI, KIE-AI, Deepgram, AssemblyAI, ElevenLabs, Cartesia, PlayHT, Inworld, AWS Polly)
- **Vision Bridge guardrail** — `visionBridge.ts` + 7 test files + dashboard tab
- **ChatGPT Web image route** — `/v1/chatgpt-web/image*` + `chatgptImageCache`
- **Redis / ioredis** — rate limiting is in-memory sliding-window, API-key validation cache is in-memory + SQLite
- **Dashboard media tabs**, **playground media examples**, **media in providers/[id] forms**

Net result: ~15 routes removed, ~30 handlers/services/translators/registries deleted, ~50 tests pruned, ~10 dependencies trimmed.

---

## Hardening on top of upstream

Coding-path bugs found and fixed during a deep audit sweep:

**Security**

- API-key cache now invalidates immediately on delete/revoke/expire (previously revoked keys kept authing for up to 1 h)
- Skill sandbox hard-caps stdout/stderr bytes + SIGTERM → grace → SIGKILL escalation
- Encryption auto-migration circuit breaker prevents CPU loops on persistent decrypt failures

**Correctness**

- AutoCombo mode packs — added missing scoring weights (NaN scores silently broke fast/cheap/quality/balanced mode switching)
- Responses API — now forwards `onStreamFailure` / `apiKeyInfo` / `cachedSettings` (stream-failure tracking, per-key cost, and semantic cache were silently disabled)
- Cursor agent Connect-RPC framing — `try/catch` around `zlib.gunzipSync`, safe sentinel emission on corrupted frames
- Cursor agent model sync — ANSI escape strip + `--list-models` flag + dual-format parser (new cursor-agent CLI wraps every line in SGR escape codes)
- Claude OAuth refresh — detect `invalid_grant` / `invalid_request` / `expired`, throw `unrecoverable_refresh_error` (stops infinite retry loop)
- **Anthropic tool prefix stripping** — `stripToolModelPrefixes` runs in both `translateRequest` AND Claude-passthrough paths (fixes `400: tools.N.model: cc/claude-opus-4-7` from real Claude Code traffic)
- **ZlibError on response forwarding** — centralized `sanitizeUpstreamHeaders()` strips `content-encoding`, `content-length`, and all 8 RFC 7230 hop-by-hop headers at every upstream-forward site
- Guardrails registry — narrow `void | GuardrailResult` before property access at 12 sites
- Compression scheduler — capture interval handle + `.unref()` (previously kept Node alive forever)
- 22+ type-safety fixes hidden by the gated typecheck

**Verified:** `typecheck:core`, `typecheck:noimplicit:core`, `lint`, `check:cycles` all clean. Live boot smoke test confirms 0 Redis / zlib / vision references in logs.

---

## Tech stack

- **Runtime:** Next.js 16 (App Router), Node ≥20.20.2 / ≥22.22.2 / ≥24, ES modules
- **Language:** TypeScript 5.9
- **Database:** `better-sqlite3` (SQLite, WAL journaling, encrypted-at-rest fields)
- **Streaming:** SSE via `@omniroute/open-sse` workspace package
- **Styling:** Tailwind CSS v4
- **Validation:** Zod v4
- **Desktop:** Electron (Windows / macOS / Linux)
- **i18n:** next-intl (40+ locales preserved from upstream)

---

## Configuration

Env vars are loaded from `~/.omnicoder/.env` (or `~/.omniroute/.env`), then `./.env`. Full list: [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

Most common:

```bash
PORT=20128                       # server port
DATA_DIR=~/.omnicoder            # SQLite + config location
STORAGE_ENCRYPTION_KEY=...       # field-encryption key (auto-generated if absent)
REQUIRE_API_KEY=false            # require auth on every API call
OMNIROUTE_MEMORY_MB=512          # max heap size
```

---

## Documentation

- [Setup Guide](docs/SETUP_GUIDE.md) · [CLI Tools](docs/CLI-TOOLS.md) · [API Reference](docs/API_REFERENCE.md) · [OpenAPI Spec](docs/openapi.yaml)
- [Architecture](docs/ARCHITECTURE.md) · [Compression Guide](docs/COMPRESSION_GUIDE.md) · [RTK Compression](docs/RTK_COMPRESSION.md) · [Resilience](docs/RESILIENCE_GUIDE.md)
- [Auto-Combo Engine](docs/AUTO-COMBO.md) · [Proxy Guide](docs/PROXY_GUIDE.md) · [Free Tiers](docs/FREE_TIERS.md)
- [MCP Server](open-sse/mcp-server/README.md) · [A2A Server](src/lib/a2a/README.md)
- [Docker](docs/DOCKER_GUIDE.md) · [VM Deployment](docs/VM_DEPLOYMENT_GUIDE.md) · [Fly.io](docs/FLY_IO_DEPLOYMENT_GUIDE.md) · [Termux](docs/TERMUX_GUIDE.md) · [PWA](docs/PWA_GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md) · [Uninstall](docs/UNINSTALL.md)

---

## Troubleshooting

| Symptom                                               | Fix                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ZlibError fetching .../v1/messages`                  | Upstream provider response headers leaked through — should not happen on this fork; report it.          |
| `400: tools.N.model: cc/claude-opus-4-7`              | Should not happen on this fork (combo prefix is stripped from nested tool models). Re-pull and rebuild. |
| `cursor-agent did not return 'Available models'`      | Upgrade `cursor-agent` to the latest version. The ANSI/`--list-models` parser supports the new format.  |
| `Failed to refresh Claude OAuth token: invalid_grant` | Re-link Claude in dashboard → Providers (refresh token expired).                                        |
| `unsupported_country_region_territory`                | Configure proxy in Settings → Proxy.                                                                    |
| `omnicoder: command not found`                        | Run `npm link` from the repo, or add `~/.local/bin` to your `PATH`.                                     |

Full troubleshooting: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

Compression engines draw on [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) and [rtk-ai/rtk](https://github.com/rtk-ai/rtk). MIT-licensed, like the upstream.

---

## License

MIT — see [LICENSE](LICENSE).

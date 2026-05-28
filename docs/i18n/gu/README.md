# 🚀 OmniCode — The Free AI Gateway (ગુજરાતી)

🌐 **Languages:** 🇺🇸 [English](../../../README.md) · 🇸🇦 [ar](../ar/README.md) · 🇧🇬 [bg](../bg/README.md) · 🇧🇩 [bn](../bn/README.md) · 🇨🇿 [cs](../cs/README.md) · 🇩🇰 [da](../da/README.md) · 🇩🇪 [de](../de/README.md) · 🇪🇸 [es](../es/README.md) · 🇮🇷 [fa](../fa/README.md) · 🇫🇮 [fi](../fi/README.md) · 🇫🇷 [fr](../fr/README.md) · 🇮🇳 [gu](../gu/README.md) · 🇮🇱 [he](../he/README.md) · 🇮🇳 [hi](../hi/README.md) · 🇭🇺 [hu](../hu/README.md) · 🇮🇩 [id](../id/README.md) · 🇮🇹 [it](../it/README.md) · 🇯🇵 [ja](../ja/README.md) · 🇰🇷 [ko](../ko/README.md) · 🇮🇳 [mr](../mr/README.md) · 🇲🇾 [ms](../ms/README.md) · 🇳🇱 [nl](../nl/README.md) · 🇳🇴 [no](../no/README.md) · 🇵🇭 [phi](../phi/README.md) · 🇵🇱 [pl](../pl/README.md) · 🇵🇹 [pt](../pt/README.md) · 🇧🇷 [pt-BR](../pt-BR/README.md) · 🇷🇴 [ro](../ro/README.md) · 🇷🇺 [ru](../ru/README.md) · 🇸🇰 [sk](../sk/README.md) · 🇸🇪 [sv](../sv/README.md) · 🇰🇪 [sw](../sw/README.md) · 🇮🇳 [ta](../ta/README.md) · 🇮🇳 [te](../te/README.md) · 🇹🇭 [th](../th/README.md) · 🇹🇷 [tr](../tr/README.md) · 🇺🇦 [uk-UA](../uk-UA/README.md) · 🇵🇰 [ur](../ur/README.md) · 🇻🇳 [vi](../vi/README.md) · 🇨🇳 [zh-CN](../zh-CN/README.md)

---


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

Data lives in `~/.omnicoder/` (legacy `~/.omniroute/` paths are still read for compatibility).

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

> ⚠️ **Heads up — OAuth / subscription accounts:** Routing through an AI subscription (instead of an API key) may violate the provider's Terms of Service. Use OAuth-based connections at your own risk — they aren't endorsed by OmniCoder. For most setups, an API key is the safer, supported route.

- **Website**: [omniroute.online](https://omniroute.online)
- **GitHub**: [github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
- **Issues**: [github.com/diegosouzapw/OmniRoute/issues](https://github.com/diegosouzapw/OmniRoute/issues)
- **WhatsApp**: [Community Group](https://chat.whatsapp.com/JI7cDQ1GyaiDHhVBpLxf8b?mode=gi_t)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md), open a PR, or pick a `good first issue`

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

> **pnpm users:** Run `pnpm approve-builds -g` after install to enable native build scripts required by `better-sqlite3` and `@swc/core`:
>
> ```bash
> pnpm install -g omniroute
> pnpm approve-builds -g   # Select all packages → approve
> omniroute
> ```

Dashboard opens at `http://localhost:20128` and API base URL is `http://localhost:20128/v1`.

#### Arch Linux (AUR)

Arch Linux users can install the [AUR package](https://aur.archlinux.org/packages/omniroute-bin), which installs OmniRoute and provides a systemd user service:

```bash
yay -S omniroute-bin
systemctl --user enable --now omniroute.service
```

| Command                 | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `omniroute`             | Start server (`PORT=20128`, API and dashboard on same port) |
| `omniroute --port 3000` | Set canonical/API port to 3000                              |
| `omniroute --mcp`       | Start MCP server (stdio transport)                          |
| `omniroute --no-open`   | Don't auto-open browser                                     |
| `omniroute --help`      | Show help                                                   |

Optional split-port mode:

```bash
PORT=20128 DASHBOARD_PORT=20129 omniroute
# API:       http://localhost:20128/v1
# Dashboard: http://localhost:20129
```

### 2) Uninstalling

When you no longer need OmniRoute, we provide two quick scripts for a clean removal:

| Command                  | Action                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `npm run uninstall`      | Removes the system app but **keeps your DB and configurations** in `~/.omniroute`.  |
| `npm run uninstall:full` | Removes the app AND permanently **erases all configurations, keys, and databases**. |

> Note: To run these commands, navigate to the OmniRoute project folder (if you cloned it) and run them. Alternatively, if globally installed, you can simply run `npm uninstall -g omniroute`.

### Long-Running Streaming Timeouts

For most deployments, you only need:

| Variable                 | Default                       | Purpose                                                                                                                                      |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_TIMEOUT_MS`     | `600000`                      | Shared baseline for upstream response-start timeout, hidden Undici timeouts, TLS fingerprint requests, and API bridge request/proxy timeouts |
| `STREAM_IDLE_TIMEOUT_MS` | inherits `REQUEST_TIMEOUT_MS` | Maximum gap between streaming chunks before OmniRoute aborts the SSE stream                                                                  |

Backward compatibility is preserved: existing `FETCH_TIMEOUT_MS`, `API_BRIDGE_PROXY_TIMEOUT_MS`, and other per-layer timeout vars still work and override the shared baseline.

For Claude Code-compatible upstreams (`anthropic-compatible-cc-*`), OmniRoute also derives the outbound `X-Stainless-Timeout` header from the resolved fetch timeout so provider-side read timeouts stay aligned with your env configuration.

For third-party Claude Code-compatible reverse proxies, OmniRoute keeps the default
`anthropic-beta` set conservative and, when `Client Cache Control` is left on `Auto`,
only forwards client-provided `cache_control` markers. If the request does not include
`cache_control`, OmniRoute does not inject bridge-owned markers.

Advanced overrides are available if you need finer control:

| Variable                                 | Default                                    | Purpose                                                              |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `FETCH_TIMEOUT_MS`                       | inherits `REQUEST_TIMEOUT_MS`              | Upstream response-start timeout used until response headers arrive   |
| `FETCH_HEADERS_TIMEOUT_MS`               | inherits `FETCH_TIMEOUT_MS`                | Undici time limit for receiving upstream response headers            |
| `FETCH_BODY_TIMEOUT_MS`                  | inherits `FETCH_TIMEOUT_MS`                | Undici time limit between upstream body chunks (`0` disables it)     |
| `FETCH_CONNECT_TIMEOUT_MS`               | `30000`                                    | Undici TCP connect timeout                                           |
| `FETCH_KEEPALIVE_TIMEOUT_MS`             | `4000`                                     | Undici idle keep-alive socket timeout                                |
| `TLS_CLIENT_TIMEOUT_MS`                  | inherits `FETCH_TIMEOUT_MS`                | Timeout for TLS fingerprint requests made through `wreq-js`          |
| `API_BRIDGE_PROXY_TIMEOUT_MS`            | inherits `REQUEST_TIMEOUT_MS` or `600000`  | Timeout for `/v1` proxy forwarding from API port to dashboard port   |
| `API_BRIDGE_SERVER_REQUEST_TIMEOUT_MS`   | `max(API_BRIDGE_PROXY_TIMEOUT_MS, 300000)` | Incoming request timeout on the API bridge server                    |
| `API_BRIDGE_SERVER_HEADERS_TIMEOUT_MS`   | `60000`                                    | Incoming header timeout on the API bridge server                     |
| `API_BRIDGE_SERVER_KEEPALIVE_TIMEOUT_MS` | `5000`                                     | Keep-alive timeout on the API bridge server                          |
| `API_BRIDGE_SERVER_SOCKET_TIMEOUT_MS`    | `0`                                        | Socket inactivity timeout on the API bridge server (`0` disables it) |

For streaming requests, `FETCH_TIMEOUT_MS` only covers connection setup / waiting for the first upstream response. Once the stream is active, OmniRoute will only abort on an actual stall (`STREAM_IDLE_TIMEOUT_MS`) or Undici body inactivity (`FETCH_BODY_TIMEOUT_MS`).

If you run OmniRoute behind Nginx, Caddy, Cloudflare, or another reverse proxy, make sure the proxy
timeouts are also higher than your OmniRoute stream/fetch timeouts.

### 2) Connect providers and create your API key

1. Open Dashboard → `Providers` and connect at least one provider (OAuth or API key).
2. Open Dashboard → `Endpoints` and create an API key.
3. (Optional) Open Dashboard → `Combos` and set your fallback chain.

### 3) Point your coding tool to OmniRoute

```txt
Base URL: http://localhost:20128/v1
API Key:  [copy from Endpoint page]
Model:    if/kimi-k2-thinking (or any provider/model prefix)
```

Works with Claude Code, Codex CLI, Gemini CLI, Cursor, Cline, OpenClaw, OpenCode, and OpenAI-compatible SDKs.

### 4) Enable and validate protocols (v2.0)

**MCP (for tool-driven operations):**

```bash
omniroute --mcp
```

Then connect your MCP client over `stdio` and test tools like:

- `omniroute_get_health`
- `omniroute_list_combos`

**A2A (for agent-to-agent workflows):**

```bash
curl http://localhost:20128/.well-known/agent.json
```

```bash
curl -X POST http://localhost:20128/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"quickstart","method":"message/send","params":{"skill":"quota-management","messages":[{"role":"user","content":"Give me a short quota summary."}]}}'
```

### 5) Validate everything end-to-end (recommended)

```bash
npm run test:protocols:e2e
```

This suite validates real MCP and A2A client flows against a running app.

### Alternative: run from source

```bash
cp .env.example .env
npm install
PORT=20128 DASHBOARD_PORT=20129 NEXT_PUBLIC_BASE_URL=http://localhost:20129 npm run dev
```

<details>
<summary><b>Void Linux (`xbps-src` template)</b></summary>

For Void Linux users, you can build a native package using `xbps-src`. Save this block as `srcpkgs/omniroute/template`:

```bash
# Template file for 'omniroute'
pkgname=omniroute
version=3.4.1
revision=1
hostmakedepends="nodejs python3 make"
depends="openssl"
short_desc="Universal AI gateway with smart routing for multiple LLM providers"
maintainer="zenobit <zenobit@disroot.org>"
license="MIT"
homepage="https://github.com/diegosouzapw/OmniRoute"
distfiles="https://github.com/diegosouzapw/OmniRoute/archive/refs/tags/v${version}.tar.gz"
checksum=009400afee90a9f32599d8fe734145cfd84098140b7287990183dde45ae2245b
system_accounts="_omniroute"
omniroute_homedir="/var/lib/omniroute"
export NODE_ENV=production
export npm_config_engine_strict=false
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false

do_build() {
	# Determine target CPU arch for node-gyp
	local _gyp_arch
	case "$XBPS_TARGET_MACHINE" in
		aarch64*) _gyp_arch=arm64 ;;
		armv7*|armv6*) _gyp_arch=arm ;;
		i686*) _gyp_arch=ia32 ;;
		*) _gyp_arch=x64 ;;
	esac

	# 1) Install all deps – skip scripts (no network in do_build, native modules
	#    compiled separately below; better-sqlite3 is serverExternalPackage so
	#    Next.js does not execute it during next build)
	NODE_ENV=development npm ci --ignore-scripts

	# 2) Build the Next.js standalone bundle
	npm run build

	# 3) Copy static assets into standalone
	cp -r .next/static .next/standalone/.next/static
	[ -d public ] && cp -r public .next/standalone/public || true

	# 4) Compile better-sqlite3 native binding for the target architecture.
	#    Use node-gyp directly so CC/CXX from xbps-src cross-toolchain are used
	#    without npm altering them.
	local _node_gyp=/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js
	(cd node_modules/better-sqlite3 && node "$_node_gyp" rebuild --arch="$_gyp_arch")

	# 5) Place the compiled binding into the standalone bundle
	local _bs3_release=.next/standalone/node_modules/better-sqlite3/build/Release
	mkdir -p "$_bs3_release"
	cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "$_bs3_release/"

	# 6) Remove arch-specific sharp bundles – upstream sets images.unoptimized=true
	#    so sharp is not used at runtime; x64 .so files would break aarch64 strip
	rm -rf .next/standalone/node_modules/@img

	# 7) Copy pino runtime deps omitted by Next.js static analysis:
	#    pino-abstract-transport – required by pino's worker thread
	#    split2 – dep of pino-abstract-transport
	#    process-warning – dep of pino itself
	for _mod in pino-abstract-transport split2 process-warning; do
		cp -r "node_modules/$_mod" .next/standalone/node_modules/
	done
}

do_check() {
	npm run test:unit
}

do_install() {
	vmkdir usr/lib/omniroute/.next

	vcopy .next/standalone/. usr/lib/omniroute/.next/standalone

	# Prevent removal of empty Next.js app router dirs by the post-install hook
	for _d in \
		.next/standalone/.next/server/app/dashboard \
		.next/standalone/.next/server/app/dashboard/settings \
		.next/standalone/.next/server/app/dashboard/providers; do
		touch "${DESTDIR}/usr/lib/omniroute/${_d}/.keep"
	done

	cat > "${WRKDIR}/omniroute" <<'EOF'
#!/bin/sh
export PORT="${PORT:-20128}"
export DATA_DIR="${DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/omniroute}"
export APP_LOG_TO_FILE="${APP_LOG_TO_FILE:-false}"
mkdir -p "${DATA_DIR}"
exec node /usr/lib/omniroute/.next/standalone/server.js "$@"
EOF
	vbin "${WRKDIR}/omniroute"
}

post_install() {
	vlicense LICENSE
}
```

</details>

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

## Scope

OmniCoder is deliberately scoped to coding workflows — chat, embeddings, web search, reranking, moderations. Media generation (images / videos / music / audio), Vision Bridge, ChatGPT Web image routes, Redis-backed rate limiting, and related dashboards are not included.

---

## Tech stack

- **Runtime:** Next.js 16 (App Router), Node ≥20.20.2 / ≥22.22.2 / ≥24, ES modules
- **Language:** TypeScript 5.9
- **Database:** `better-sqlite3` (SQLite, WAL journaling, encrypted-at-rest fields)
- **Streaming:** SSE via `@omnicoder/open-sse` workspace package
- **Styling:** Tailwind CSS v4
- **Validation:** Zod v4
- **Desktop:** Electron (Windows / macOS / Linux)
- **i18n:** next-intl, 40+ locales

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

<a href="https://www.star-history.com/?repos=diegosouzapw%2Fomniroute&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=diegosouzapw/omniroute&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=diegosouzapw/omniroute&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=diegosouzapw/omniroute&type=date&legend=top-left" />
 </picture>
</a>

## 🌍 StarMapper

<a href="https://starmapper.bruniaux.com/diegosouzapw/omniroute">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://starmapper.bruniaux.com/api/map-image/diegosouzapw/omniroute?theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://starmapper.bruniaux.com/api/map-image/diegosouzapw/omniroute?theme=light" />
    <img alt="StarMapper" src="https://starmapper.bruniaux.com/api/map-image/diegosouzapw/omniroute" />
  </picture>
</a>

## 🙏 Acknowledgments

Special thanks to **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — the original Go implementation that inspired this JavaScript port.

---

## Troubleshooting

| Symptom                                               | Fix                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ZlibError fetching .../v1/messages`                  | Provider response headers leaked through — should not happen; please report it.                         |
| `400: tools.N.model: cc/claude-opus-4-7`              | Should not happen — combo prefix is stripped from nested tool models. Re-pull and rebuild.              |
| `cursor-agent did not return 'Available models'`      | Upgrade `cursor-agent` to the latest version. The ANSI/`--list-models` parser supports the new format.  |
| `Failed to refresh Claude OAuth token: invalid_grant` | Re-link Claude in dashboard → Providers (refresh token expired).                                        |
| `unsupported_country_region_territory`                | Configure proxy in Settings → Proxy.                                                                    |
| `omnicoder: command not found`                        | Run `npm link` from the repo, or add `~/.local/bin` to your `PATH`.                                     |

Full troubleshooting: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

Compression engines draw on [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) and [rtk-ai/rtk](https://github.com/rtk-ai/rtk), both MIT-licensed.

---

## License

MIT — see [LICENSE](LICENSE).

#!/usr/bin/env node
// Sync the cursor models list in open-sse/config/providerRegistry.ts from
// cursor-agent's runtime model list. Triggers an intentional invalid --model
// invocation so cursor-agent prints "Available models: ..." on stderr.
//
// Usage:
//   node scripts/sync-cursor-models.mjs              # spawn cursor-agent and apply
//   node scripts/sync-cursor-models.mjs --dry-run    # print proposed block, don't write
//   node scripts/sync-cursor-models.mjs --from-stdin # read the error message from stdin

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "..", "open-sse", "config", "providerRegistry.ts");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FROM_STDIN = args.has("--from-stdin");

function readSource() {
  if (FROM_STDIN) return readFileSync(0, "utf8");
  // cursor-agent 2026.05+ supports `--list-models` (prints to stdout, exits 0).
  // Older builds need the legacy `--model --help` trick that printed "Available
  // models: ..." to stderr with a non-zero exit. We try the new flag first.
  let r = spawnSync("cursor-agent", ["--list-models"], { encoding: "utf8" });
  let text = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (!/Available models/i.test(text)) {
    r = spawnSync("cursor-agent", ["--model", "--help"], { encoding: "utf8" });
    text = `${r.stdout || ""}\n${r.stderr || ""}`;
  }
  return text;
}

// `auto` is a CLI-side abstraction (cursor-agent resolves it locally before
// sending) and `composer-*` targets cursor's edit/composer endpoint, neither
// of which work via the chat RPC. Filter them so the dashboard never offers
// them to the chat path. Pass --include-unsupported to keep them.
function isUnsupportedChatModel(id) {
  if (id === "auto") return true;
  if (id.startsWith("composer-")) return true;
  return false;
}

function parseModelIds(text) {
  const includeUnsupported = args.has("--include-unsupported");
  const out = [];
  const seen = new Set();

  // cursor-agent emits ANSI SGR escape codes around the header and around each
  // model id. Strip them before parsing.
  const ansiStripped = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

  // New cursor-agent format (2026.05+): "Available models" (no colon) followed
  // by blank line and then `<id> - <name>` per line until a blank line or "Tip:".
  const headerIdx = ansiStripped.search(/Available models\b/i);
  if (headerIdx !== -1) {
    const lines = ansiStripped.slice(headerIdx).split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        if (out.length > 0) break;
        continue;
      }
      if (/^Tip\b/i.test(line)) break;
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[-\u2014]\s*.+)?$/);
      if (!m) {
        if (out.length > 0) break;
        continue;
      }
      const id = m[1];
      if (seen.has(id)) continue;
      if (!includeUnsupported && isUnsupportedChatModel(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length > 0) return out;
  }

  // Legacy format (pre-2026.05): comma-separated after `Available models:`.
  const legacy = ansiStripped.match(/Available models:\s*([^\n]+)/);
  if (!legacy) {
    throw new Error("Could not find 'Available models' line in cursor-agent output");
  }
  for (const raw of legacy[1].split(",")) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    if (!includeUnsupported && isUnsupportedChatModel(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const SEGMENT_OVERRIDES = {
  gpt: "GPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  composer: "Composer",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  codex: "Codex",
  mini: "Mini",
  nano: "Nano",
  max: "Max",
  high: "High",
  low: "Low",
  medium: "Medium",
  xhigh: "XHigh",
  none: "None",
  fast: "Fast",
  thinking: "Thinking",
  extra: "Extra",
  spark: "Spark",
  preview: "Preview",
  flash: "Flash",
  pro: "Pro",
};

// Pretty-print an id by:
//  1) collapsing claude-NAME-X-Y dotted version (e.g. claude-opus-4-7 → claude-opus-4.7)
//  2) splitting on '-'
//  3) applying SEGMENT_OVERRIDES; falling back to capitalize-first
function humanize(id) {
  if (id === "auto") return "Auto (Server Picks)";

  // Collapse "X-Y" numeric suffix in claude-foo-X-Y- patterns into "X.Y"
  const collapsed = id.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
  const parts = collapsed.split("-");
  const labelled = parts.map((p) => {
    if (SEGMENT_OVERRIDES[p]) return SEGMENT_OVERRIDES[p];
    if (/^\d/.test(p)) return p; // leave version numbers / "k2.5" alone
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  return labelled.join(" ");
}

function buildModelsArrayLines(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`      { id: ${JSON.stringify(id)}, name: ${JSON.stringify(humanize(id))} },`);
  }
  return out.join("\n");
}

function replaceCursorModels(source, modelsBlock) {
  // Match the `cursor:` provider entry and replace just its `models: [ ... ],` array.
  const re = /(\n  cursor:\s*\{[\s\S]*?\n    models:\s*\[)([\s\S]*?)(\n    \],)/;
  if (!re.test(source)) throw new Error("Could not locate cursor.models array in registry");
  return source.replace(re, `$1\n${modelsBlock}$3`);
}

const ids = parseModelIds(readSource());
const block = buildModelsArrayLines(ids);

if (DRY_RUN) {
  console.log(block);
  process.exit(0);
}

const before = readFileSync(REGISTRY_PATH, "utf8");
const after = replaceCursorModels(before, block);
if (before === after) {
  console.log("No changes — cursor models already in sync.");
  process.exit(0);
}
writeFileSync(REGISTRY_PATH, after);
console.log(`Updated ${ids.length} cursor models in ${REGISTRY_PATH}`);

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// cursor-agent waits on stdin when given a piped fd, so we always launch it
// with stdin closed ("ignore") so it exits as soon as it prints the model list.
function runCursorAgent(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

// Resolve cursor-agent across common install locations, since the standalone
// Next.js server may run with a PATH that doesn't include the user's local bin.
function resolveCursorAgentBinary(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "cursor-agent"),
    "/root/.local/bin/cursor-agent",
    "/usr/local/bin/cursor-agent",
    "/usr/bin/cursor-agent",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: PATH-based lookup (lets execFile do the resolution).
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, "cursor-agent");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const SEGMENT_OVERRIDES: Record<string, string> = {
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

export function humanizeCursorModelId(id: string): string {
  if (id === "auto") return "Auto (Server Picks)";

  // Collapse digit-dash-digit suffixes (e.g. claude-opus-4-7 → claude-opus-4.7)
  // so version numbers read naturally.
  const collapsed = id.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
  return collapsed
    .split("-")
    .map((part) => {
      if (SEGMENT_OVERRIDES[part]) return SEGMENT_OVERRIDES[part];
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function parseCursorAgentModels(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // cursor-agent emits ANSI SGR escape codes around the header and around each
  // model id (e.g. \u001b[2mAvailable models\u001b[22m, \u001b[36mauto\u001b[39m).
  // Strip them before parsing so anchors and character classes work.
  // Matches: ESC [ ... letter — covers all CSI/SGR sequences.
  const ansiStripped = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

  // New cursor-agent format (2026.05+):
  //   Available models
  //
  //   auto - Auto
  //   composer-2-fast - Composer 2 Fast (current, default)
  //   ...
  //   kimi-k2.5 - Kimi K2.5
  //
  //   Tip: use --model <id> ...
  //
  // The header is `Available models` (no colon) followed by blank line and
  // then `<id> - <name>` per line until a blank line or "Tip:".
  const headerIdx = ansiStripped.search(/Available models\b/i);
  if (headerIdx !== -1) {
    const after = ansiStripped.slice(headerIdx);
    const lines = after.split(/\r?\n/);
    // Skip the header line itself.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        // Blank line: skip while still pre-list; once we've seen entries, blank
        // means end of list.
        if (out.length > 0) break;
        continue;
      }
      if (/^Tip\b/i.test(line)) break;
      // Match `id [optional - name]` — accept either "id - Name" (new) or just
      // a bare id (legacy fallback). Stop on the first non-matching line if
      // we've already collected entries.
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[-\u2014]\s*.+)?$/);
      if (!m) {
        if (out.length > 0) break;
        continue;
      }
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    if (out.length > 0) return out;
  }

  // Legacy format (pre-2026.05):
  //   Cannot use this model: --help. Available models: auto, composer-2, ...
  const legacy = ansiStripped.match(/Available models:\s*([^\n]+)/);
  if (legacy) {
    for (const raw of legacy[1].split(",")) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export type CursorAgentModelEntry = {
  id: string;
  name: string;
  owned_by: "cursor";
};

export async function fetchCursorAgentModels(
  options: { binary?: string; timeoutMs?: number } = {}
): Promise<CursorAgentModelEntry[]> {
  const binary = options.binary || resolveCursorAgentBinary();
  const timeoutMs = options.timeoutMs ?? 5000;

  if (!binary) {
    throw new Error(
      "cursor-agent binary not found. Install it (curl https://cursor.com/install -fsS | bash) so ~/.local/bin/cursor-agent exists, or pass a binary path explicitly."
    );
  }

  // cursor-agent 2026.05+ exposes a proper `--list-models` flag that prints
  // the model list to stdout and exits 0. On older builds we fall back to the
  // legacy `--model --help` trick that printed "Available models: ..." to
  // stderr. Either way we feed combined output to parseCursorAgentModels.
  let result: { stdout: string; stderr: string };
  try {
    result = await runCursorAgent(binary, ["--list-models"], timeoutMs);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      throw new Error(`cursor-agent binary not executable at ${binary}`);
    }
    throw err;
  }
  let combined = `${result.stdout}\n${result.stderr}`;

  let ids = parseCursorAgentModels(combined);
  if (ids.length === 0) {
    // Fallback: older cursor-agent builds that don't accept --list-models.
    try {
      const legacy = await runCursorAgent(binary, ["--model", "--help"], timeoutMs);
      combined = `${legacy.stdout}\n${legacy.stderr}`;
      ids = parseCursorAgentModels(combined);
    } catch {
      // Swallow — fall through to the diagnostic error below.
    }
  }
  if (ids.length === 0) {
    throw new Error("cursor-agent did not return an 'Available models' list");
  }

  return ids.map((id) => ({
    id,
    name: humanizeCursorModelId(id),
    owned_by: "cursor" as const,
  }));
}

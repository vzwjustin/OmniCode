#!/usr/bin/env node
/**
 * check-env-coverage — verify that every env var read by source code is
 * documented in .env.example, and vice-versa.
 *
 * Inputs:
 *   - .env.example (the documented contract)
 *   - All `.ts`, `.tsx`, `.mjs`, `.cjs`, `.js` files under src/, open-sse/,
 *     scripts/, bin/, electron/ (the actual code)
 *
 * Outputs (printed to stdout):
 *   - Documented but unused (low-impact noise)
 *   - Used but undocumented (real drift — this is the main concern)
 *
 * Exit code:
 *   - 0 if every used var is documented
 *   - 1 if there's at least one undocumented `process.env.X` reference
 *
 * Notes:
 *   - We intentionally exclude well-known platform vars (NODE_ENV, PORT,
 *     HOST, CI, HOME, PATH, TZ, etc.) because they're either system-set or
 *     well-known.
 *   - Dynamic env reads like `process.env[${provider}_OAUTH_CLIENT_ID]` are
 *     reported as a single "dynamic" hint rather than as failures (we can't
 *     enumerate them statically).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const ROOTS = ["src", "open-sse", "scripts", "bin", "electron"].map((d) => path.join(ROOT, d));

const ALLOWLIST_PLATFORM = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "CI",
  "HOME",
  "PATH",
  "PATHEXT",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OSTYPE",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "VIRTUAL_ENV",
  "npm_lifecycle_event",
  "npm_package_version",
  "npm_package_name",
  "npm_config_cache",
  "npm_config_local_prefix",
  "NPM_TOKEN",
  // GitHub Actions reserved
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKSPACE",
  "GITHUB_EVENT_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_HEAD_REF",
  "GITHUB_BASE_REF",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_API_URL",
  "GITHUB_SERVER_URL",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_TOKEN",
  "GITHUB_ACTOR",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  // Test runner reserved
  "VITEST",
  "VITEST_WORKER_ID",
  "VITEST_POOL_ID",
  "JEST_WORKER_ID",
  "PLAYWRIGHT_BROWSERS_PATH",
  // Next.js conventions
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "TURBOPACK",
  "__NEXT_PRIVATE_PREBUNDLED_REACT",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "DEBUG",
  "FORCE_COLOR",
  "NO_COLOR",
  "FORCE_LIGHT",
  "FORCE_DARK",
  // Cross-env conventions
  "cross_env_NODE_ENV",
]);

const EXCLUDE_DIR = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "coverage",
  ".git",
  "dist",
  "out",
  "build",
  ".vscode",
  ".husky",
  "_references",
  "_tasks",
  "_mono_repo",
]);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (EXCLUDE_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) yield full;
  }
}

function extractEnvNames(source) {
  // Match: process.env.FOO or process.env["FOO"] or process.env['FOO']
  const out = new Set();
  let dynamic = false;
  const re = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[(?:\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*)\])/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1] || m[2];
    if (name) out.add(name);
  }
  // Detect bracket access with non-literal expression (dynamic):
  //   process.env[`${provider}_OAUTH_CLIENT_ID`]
  //   process.env[provider + "_X"]
  if (/process\.env\[[^]`'"]*(?:\$\{|\+)/.test(source)) dynamic = true;
  return { names: out, dynamic };
}

function extractDocumentedEnvNames(envExampleSource) {
  // Lines like `FOO=bar` or `# FOO=bar` are considered "documented".
  const out = new Set();
  const re = /^[ \t]*#?[ \t]*([A-Z_][A-Z0-9_]*)\s*=/gm;
  let m;
  while ((m = re.exec(envExampleSource))) out.add(m[1]);
  return out;
}

const envExample = fs.readFileSync(ENV_EXAMPLE, "utf8");
const documented = extractDocumentedEnvNames(envExample);

const used = new Set();
let sawDynamic = false;
let filesScanned = 0;
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, "utf8");
    const { names, dynamic } = extractEnvNames(src);
    for (const n of names) used.add(n);
    if (dynamic) sawDynamic = true;
    filesScanned++;
  }
}

const usedButUndocumented = Array.from(used)
  .filter((n) => !documented.has(n) && !ALLOWLIST_PLATFORM.has(n))
  .sort();
const documentedButUnused = Array.from(documented)
  .filter((n) => !used.has(n) && !ALLOWLIST_PLATFORM.has(n))
  .sort();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (col, str) => (useColor ? `\x1b[${col}m${str}\x1b[0m` : str);

console.log(`Scanned ${filesScanned} source files`);
console.log(`Documented in .env.example: ${documented.size}`);
console.log(`Used via process.env: ${used.size}`);
if (sawDynamic) {
  console.log(c("33", "Dynamic env access detected (process.env[`${...}_X`]). Skipping those by design."));
}
console.log("");

if (usedButUndocumented.length > 0) {
  console.log(c("31", `✖ Used but undocumented (${usedButUndocumented.length}):`));
  for (const n of usedButUndocumented) console.log(`  - ${n}`);
} else {
  console.log(c("32", "✓ Every env var read in code is documented in .env.example"));
}
console.log("");

if (documentedButUnused.length > 0) {
  console.log(c("33", `⚠ Documented but unused (${documentedButUnused.length}):`));
  for (const n of documentedButUnused) console.log(`  - ${n}`);
} else {
  console.log(c("32", "✓ Every documented env var has at least one reader"));
}

if (usedButUndocumented.length > 0) process.exit(1);
process.exit(0);

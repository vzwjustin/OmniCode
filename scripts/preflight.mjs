#!/usr/bin/env node
/**
 * omniroute preflight — quick pre-commit / pre-push sanity gate.
 *
 * Runs (in order):
 *   1. scripts/doctor.mjs — env / port / DATA_DIR / Redis sanity
 *   2. eslint on staged files (or --all)
 *   3. typecheck:core
 *   4. test:plan3  (a tiny, fast subset of the unit suite)
 *
 * Use it locally with `npm run preflight` before committing. The aim is to
 * catch the embarrassing failures (missing env, blatant lint, basic type
 * errors, the smallest test smoke) in under a minute rather than waiting for
 * the pre-push hook or CI.
 *
 * Exits with a non-zero code on the first failing step so wrapping shells
 * can `set -e` over it.
 */
import { spawnSync } from "node:child_process";

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (name, str) => (useColor ? `${COLOR[name]}${str}${COLOR.reset}` : str);

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const SKIP_TEST = args.includes("--skip-test");

function step(label, cmd, cmdArgs, env = {}) {
  console.log("");
  console.log(c("bold", `▶ ${label}`));
  console.log(c("dim", `  $ ${cmd} ${cmdArgs.join(" ")}`));
  const t0 = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status === 0) {
    console.log(c("green", `  ✓ ${label} (${dt}s)`));
    return true;
  }
  console.log(c("red", `  ✖ ${label} failed (${dt}s, exit ${res.status})`));
  process.exit(res.status || 1);
}

console.log(c("bold", "OmniRoute preflight"));
if (ALL) console.log(c("dim", "  (--all: lint every file, not just staged)"));
if (SKIP_TEST) console.log(c("dim", "  (--skip-test: skipping test:plan3)"));

// 1) Doctor — non-blocking; we tolerate warnings (exit 2) but fail on exit 1.
console.log("");
console.log(c("bold", "▶ doctor"));
{
  const res = spawnSync(process.execPath, ["scripts/doctor.mjs"], { stdio: "inherit" });
  if (res.status === 1) {
    console.log(c("red", "  ✖ doctor reported blocking errors"));
    process.exit(1);
  }
  if (res.status === 2) {
    console.log(c("yellow", "  ⚠ doctor reported warnings (continuing)"));
  } else {
    console.log(c("green", "  ✓ doctor clean"));
  }
}

// 2) Lint
if (ALL) {
  step("lint --all", "npx", ["eslint", "src", "open-sse", "tests", "scripts", "bin"]);
} else {
  // Use lint-staged-style discovery: run eslint on the union of staged + tracked-modified files
  const diffRes = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], {
    encoding: "utf8",
  });
  const staged = (diffRes.stdout || "")
    .split("\n")
    .filter((f) => f && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  if (staged.length === 0) {
    console.log("");
    console.log(c("bold", "▶ lint"));
    console.log(c("dim", "  (no staged JS/TS changes — skipping)"));
  } else {
    step("lint (changed files)", "npx", ["eslint", ...staged]);
  }
}

// 3) Typecheck
step("typecheck:core", "npm", ["run", "typecheck:core", "--silent"]);

// 4) Tests
if (!SKIP_TEST) {
  step("test:plan3 (fast smoke)", "npm", ["run", "test:plan3", "--silent"]);
}

console.log("");
console.log(c("green", c("bold", "All checks passed ✓")));

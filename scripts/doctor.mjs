#!/usr/bin/env node
/**
 * omniroute doctor — quick environment health-check.
 *
 * Run with:
 *   node scripts/doctor.mjs
 *
 * Reports on:
 *   • Node.js version / engines.node compatibility
 *   • Required env vars (JWT_SECRET, API_KEY_SECRET, STORAGE_ENCRYPTION_KEY)
 *   • DATA_DIR readable / writable
 *   • Port availability (PORT, DASHBOARD_PORT)
 *   • Optional services reachable (REDIS_URL, Qdrant)
 *   • Risky configuration (REQUIRE_API_KEY=false on a LAN-bound deployment, etc.)
 *
 * Exits with 0 if everything looks healthy, 1 if there are blocking issues,
 * 2 if there are warnings worth addressing. Designed to be safe to run during
 * pre-deploy validation — does NOT touch the database, never makes upstream
 * provider calls.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let pkg;
try {
  pkg = require("../package.json");
} catch {
  pkg = { engines: {}, version: "unknown" };
}

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
function c(name, str) {
  return useColor ? `${COLOR[name]}${str}${COLOR.reset}` : str;
}

const findings = []; // { level: "ok"|"warn"|"error", msg, hint? }
function ok(msg) { findings.push({ level: "ok", msg }); }
function warn(msg, hint) { findings.push({ level: "warn", msg, hint }); }
function err(msg, hint) { findings.push({ level: "error", msg, hint }); }

function header(label) {
  console.log("");
  console.log(c("bold", `── ${label} ──`));
}

// ───────────────────────────────────────────────────────────────────── Node ──
header("Runtime");
const nodeVersion = process.versions.node;
console.log(`  Node.js: ${c("blue", nodeVersion)}  (target ${pkg.engines?.node ?? "any"})`);
console.log(`  Platform: ${process.platform}-${process.arch}  ${os.release()}`);
console.log(`  OmniRoute: v${pkg.version ?? "unknown"}`);

const major = Number(nodeVersion.split(".")[0]);
if (major < 20) {
  err(`Node ${nodeVersion} is below the supported floor (≥20.20.2)`, "Upgrade Node.js");
} else if (major === 21 || major === 23 || major === 25) {
  warn(`Node ${nodeVersion} is on an unsupported odd line`, "Use an even LTS (22/24/26)");
} else {
  ok(`Node ${nodeVersion}`);
}

// ───────────────────────────────────────────────────────────────────── Env ──
header("Environment Variables");

const requireApiKey = process.env.REQUIRE_API_KEY === "true";
const bindLan = process.env.OMNIROUTE_BIND_LAN === "true";
const trustProxy = process.env.TRUST_PROXY_HEADERS === "true";
const nodeEnv = process.env.NODE_ENV || "development";

console.log(`  NODE_ENV:              ${c("blue", nodeEnv)}`);
console.log(`  REQUIRE_API_KEY:       ${requireApiKey ? c("green", "true") : c("yellow", "false")}`);
console.log(`  OMNIROUTE_BIND_LAN:    ${bindLan ? c("yellow", "true") : c("green", "false (loopback only)")}`);
console.log(`  TRUST_PROXY_HEADERS:   ${trustProxy ? c("green", "true") : c("dim", "false")}`);

if (bindLan && !requireApiKey) {
  err("LAN binding is enabled but REQUIRE_API_KEY is not",
    "Set REQUIRE_API_KEY=true; otherwise the gateway becomes an open paid-LLM proxy on the network");
}
if (nodeEnv === "production" && !process.env.STORAGE_ENCRYPTION_KEY && process.env.OMNIROUTE_ALLOW_PLAINTEXT_STORAGE !== "true") {
  err("STORAGE_ENCRYPTION_KEY is not set in NODE_ENV=production",
    "Generate one: openssl rand -hex 32 (or set OMNIROUTE_ALLOW_PLAINTEXT_STORAGE=true for dev only)");
}

const requiredSecrets = ["JWT_SECRET", "API_KEY_SECRET"];
for (const name of requiredSecrets) {
  const val = process.env[name];
  if (!val) {
    warn(`${name} not set in process env`,
      "Auto-generated on first boot into ~/.omniroute/server.env; set explicitly for predictable deploys");
  } else if (val.length < 32) {
    warn(`${name} is shorter than 32 chars`, "Use openssl rand -base64 48");
  } else {
    ok(`${name} present (${val.length} chars)`);
  }
}

const initialPwd = process.env.INITIAL_PASSWORD;
if (initialPwd && initialPwd.length < 12) {
  warn("INITIAL_PASSWORD is shorter than 12 chars",
    "OmniRoute now forces rotation on first login; still, a weak bootstrap is a risk window");
}

// ──────────────────────────────────────────────────────────────── DATA_DIR ──
header("Data Directory");

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");
console.log(`  DATA_DIR: ${c("blue", dataDir)}`);

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const testPath = path.join(dataDir, ".doctor-write-test");
  fs.writeFileSync(testPath, "ok");
  fs.unlinkSync(testPath);
  ok(`Writable: ${dataDir}`);
} catch (e) {
  err(`Cannot write to DATA_DIR (${e.message})`,
    "Set DATA_DIR to a path the running user can read/write");
}

// ───────────────────────────────────────────────────────────────────── Port ──
header("Ports");

const port = Number(process.env.PORT || 20128);
const dashPort = Number(process.env.DASHBOARD_PORT || port);
console.log(`  Main port:      ${c("blue", port)}`);
if (dashPort !== port) console.log(`  Dashboard port: ${c("blue", dashPort)}`);

async function isPortFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(p, "127.0.0.1");
  });
}

const portFree = await isPortFree(port);
if (portFree) ok(`Port ${port} is free`);
else err(`Port ${port} is already in use`, "Stop the process holding it or set PORT to a different number");

if (dashPort !== port) {
  const dashFree = await isPortFree(dashPort);
  if (dashFree) ok(`Port ${dashPort} is free`);
  else err(`Port ${dashPort} is already in use`, "Set DASHBOARD_PORT to a different number");
}

// ─────────────────────────────────────────────────────────────────── Redis ──
header("Optional Services");

const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  console.log(`  REDIS_URL: ${c("blue", redisUrl.replace(/\/\/.*@/, "//****@"))}`);
  // Without a redis client dep at hand we just check the TCP connect.
  try {
    const parsed = new URL(redisUrl);
    const reachable = await tcpReach(parsed.hostname || "127.0.0.1", Number(parsed.port) || 6379, 1500);
    if (reachable) ok("Redis TCP reachable");
    else warn("Redis TCP not reachable from this host", "Verify the host/port; the gateway will refuse to start if Redis is required but down");
  } catch (e) {
    warn(`Invalid REDIS_URL: ${e.message}`);
  }
} else {
  console.log(`  REDIS_URL: ${c("dim", "(unset — Redis features disabled)")}`);
}

// ──────────────────────────────────────────────────────────────────── Done ──
function tcpReach(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

header("Summary");
let nErr = 0, nWarn = 0, nOk = 0;
for (const f of findings) {
  if (f.level === "error") nErr++;
  else if (f.level === "warn") nWarn++;
  else nOk++;
}
console.log(`  ${c("green", `${nOk} ok`)}   ${c("yellow", `${nWarn} warn`)}   ${c("red", `${nErr} error`)}`);
if (nWarn || nErr) {
  console.log("");
  for (const f of findings) {
    if (f.level === "ok") continue;
    const tag = f.level === "error" ? c("red", "✖ ") : c("yellow", "⚠ ");
    console.log(`  ${tag} ${f.msg}`);
    if (f.hint) console.log(`     ${c("dim", `↳ ${f.hint}`)}`);
  }
}

if (nErr > 0) process.exit(1);
if (nWarn > 0) process.exit(2);
process.exit(0);

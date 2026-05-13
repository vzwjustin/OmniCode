import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-tools-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tmpDir;

const core = await import("../../src/lib/db/core.ts");
const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
const memoryStore = await import("../../src/lib/memory/store.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  core.getDbInstance();
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function authExtra(apiKeyId: string) {
  // Simulate the MCP transport handing the tool a validated AuthInfo with a
  // tenant-scoped clientId. The handler MUST derive the effective tenant from
  // this, never from user-supplied input.
  return { authInfo: { clientId: apiKeyId, scopes: ["*"], extra: { apiKeyId } } } as const;
}

test("memory add stores entries with default session and metadata", async () => {
  const result = await memoryTools.omniroute_memory_add.handler(
    {
      type: "factual",
      key: "pref:language",
      content: "TypeScript is preferred.",
    },
    authExtra("key-add")
  );

  const rowsResult = await memoryStore.listMemories({ apiKeyId: "key-add" });
  const rows = Array.isArray(rowsResult) ? rowsResult : rowsResult.data;

  assert.equal(result.success, true);
  assert.equal(result.data.message, "Memory created successfully");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "");
  assert.deepEqual(rows[0].metadata, {});
  assert.equal(rows[0].content, "TypeScript is preferred.");
});

test("memory tools ignore caller-supplied apiKeyId and rely on auth context", async () => {
  // Even if the caller tries to inject an apiKeyId via input, it MUST be ignored.
  await memoryTools.omniroute_memory_add.handler(
    {
      // @ts-expect-error: schema no longer permits apiKeyId; runtime must drop it.
      apiKeyId: "victim-tenant",
      type: "factual",
      key: "pref:lang",
      content: "Should be stored against the authenticated tenant, not 'victim-tenant'.",
    },
    authExtra("authed-tenant")
  );

  const victimRowsResult = await memoryStore.listMemories({ apiKeyId: "victim-tenant" });
  const victimRows = Array.isArray(victimRowsResult) ? victimRowsResult : victimRowsResult.data;
  assert.equal(victimRows.length, 0, "must not write to victim tenant");

  const authedRowsResult = await memoryStore.listMemories({ apiKeyId: "authed-tenant" });
  const authedRows = Array.isArray(authedRowsResult) ? authedRowsResult : authedRowsResult.data;
  assert.equal(authedRows.length, 1, "must write to authenticated tenant only");
});

test("memory search filters by type, enforces limit, and reports token totals", async () => {
  await memoryTools.omniroute_memory_add.handler(
    {
      sessionId: "search",
      type: "factual",
      key: "pref:stack",
      content: "TypeScript and Node.js are used for backend work.",
      metadata: { source: "user" },
    },
    authExtra("key-search")
  );
  await memoryTools.omniroute_memory_add.handler(
    {
      sessionId: "search",
      type: "semantic",
      key: "pref:hobby",
      content: "Gardening is a weekend hobby.",
      metadata: { source: "user" },
    },
    authExtra("key-search")
  );
  await memoryTools.omniroute_memory_add.handler(
    {
      sessionId: "search",
      type: "factual",
      key: "pref:language",
      content: "TypeScript services are written every day.",
      metadata: { source: "user" },
    },
    authExtra("key-search")
  );

  const result = await memoryTools.omniroute_memory_search.handler(
    {
      query: "typescript backend",
      type: "factual",
      limit: 1,
    },
    authExtra("key-search")
  );

  assert.equal(result.success, true);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.memories.length, 1);
  assert.equal(result.data.memories[0].type, "factual");
  assert.match(result.data.memories[0].content, /TypeScript/i);
  assert.ok(result.data.totalTokens > 0);
});

test("memory clear deletes only older filtered entries and reports the deleted count", async () => {
  const older = await memoryStore.createMemory({
    apiKeyId: "key-clear",
    sessionId: "clear",
    type: "factual",
    key: "old",
    content: "This memory should be removed.",
    metadata: {},
    expiresAt: null,
  });
  const newer = await memoryStore.createMemory({
    apiKeyId: "key-clear",
    sessionId: "clear",
    type: "factual",
    key: "new",
    content: "This memory should remain.",
    metadata: {},
    expiresAt: null,
  });

  const db = core.getDbInstance();
  const cutoff = new Date("2025-01-01T00:00:00.000Z");
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
    "2024-01-01T00:00:00.000Z",
    older.id
  );
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
    "2025-06-01T00:00:00.000Z",
    newer.id
  );

  const result = await memoryTools.omniroute_memory_clear.handler(
    {
      type: "factual",
      olderThan: cutoff.toISOString(),
    },
    authExtra("key-clear")
  );

  const remainingResult = await memoryStore.listMemories({ apiKeyId: "key-clear" });
  const remaining = Array.isArray(remainingResult) ? remainingResult : remainingResult.data;

  assert.equal(result.success, true);
  assert.equal(result.data.deletedCount, 1);
  assert.equal(result.data.message, "Cleared 1 memories");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, newer.id);
});

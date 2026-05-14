import test from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════
//  Registry Utilities Unit Tests
//  Tests for parseModelFromRegistry, getAllModelsFromRegistry,
//  buildAuthHeaders — shared abstractions from PR #167
// ═══════════════════════════════════════════════════════════════

const { parseModelFromRegistry, getAllModelsFromRegistry, buildAuthHeaders } =
  await import("../../open-sse/config/registryUtils.ts");

// ─── Test fixtures ────────────────────────────────────────────

const MOCK_REGISTRY = {
  groq: {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authType: "apikey",
    authHeader: "bearer",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
    ],
  },
  ollama: {
    id: "ollama",
    baseUrl: "http://localhost:11434",
    authType: "none",
    authHeader: "none",
    models: [
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder" },
      { id: "deepseek-coder-v2", name: "DeepSeek Coder V2" },
    ],
  },
  nvidia: {
    id: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authType: "apikey",
    authHeader: "bearer",
    models: [{ id: "nemotron-4-340b-instruct", name: "Nemotron 4 340B" }],
  },
};

// ═══════════════════════════════════════════════════════════════
//  parseModelFromRegistry
// ═══════════════════════════════════════════════════════════════

test("parseModelFromRegistry: returns null provider for null input", () => {
  const result = parseModelFromRegistry(null, MOCK_REGISTRY);
  assert.deepEqual(result, { provider: null, model: null });
});

test("parseModelFromRegistry: returns null provider for empty string", () => {
  const result = parseModelFromRegistry("", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: null, model: null });
});

test("parseModelFromRegistry: parses provider/model prefix correctly", () => {
  const result = parseModelFromRegistry("groq/llama-3.3-70b-versatile", MOCK_REGISTRY);
  assert.deepEqual(result, {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
  });
});

test("parseModelFromRegistry: parses ollama/qwen2.5-coder correctly", () => {
  const result = parseModelFromRegistry("ollama/qwen2.5-coder", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: "ollama", model: "qwen2.5-coder" });
});

test("parseModelFromRegistry: finds bare model ID without provider prefix", () => {
  const result = parseModelFromRegistry("deepseek-coder-v2", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: "ollama", model: "deepseek-coder-v2" });
});

test("parseModelFromRegistry: finds bare model in first matching provider", () => {
  const result = parseModelFromRegistry("nemotron-4-340b-instruct", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: "nvidia", model: "nemotron-4-340b-instruct" });
});

test("parseModelFromRegistry: returns null provider for unknown model", () => {
  const result = parseModelFromRegistry("nonexistent-model", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: null, model: "nonexistent-model" });
});

test("parseModelFromRegistry: handles model ID that looks like a provider prefix but isn't", () => {
  const result = parseModelFromRegistry("unknown-provider/some-model", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: null, model: "unknown-provider/some-model" });
});

test("parseModelFromRegistry: handles provider prefix with no matching model", () => {
  // Provider exists but model doesn't — still returns the provider from prefix match
  const result = parseModelFromRegistry("nvidia/nonexistent", MOCK_REGISTRY);
  assert.deepEqual(result, { provider: "nvidia", model: "nonexistent" });
});

// ═══════════════════════════════════════════════════════════════
//  getAllModelsFromRegistry
// ═══════════════════════════════════════════════════════════════

test("getAllModelsFromRegistry: returns all models with prefixed IDs", () => {
  const models = getAllModelsFromRegistry(MOCK_REGISTRY);

  // Total: groq(2) + ollama(2) + nvidia(1) = 5
  assert.equal(models.length, 5);

  // Check IDs are prefixed
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes("groq/llama-3.3-70b-versatile"));
  assert.ok(ids.includes("ollama/qwen2.5-coder"));
  assert.ok(ids.includes("nvidia/nemotron-4-340b-instruct"));
});

test("getAllModelsFromRegistry: each model has provider field", () => {
  const models = getAllModelsFromRegistry(MOCK_REGISTRY);

  for (const model of models) {
    assert.ok(model.provider, `Model ${model.id} missing provider field`);
    assert.ok(model.name, `Model ${model.id} missing name field`);
  }
});

test("getAllModelsFromRegistry: extra callback adds fields per provider", () => {
  const models = getAllModelsFromRegistry(MOCK_REGISTRY, (providerId, config) => ({
    authType: config.authType,
  }));

  const groqModel = models.find((m) => m.id === "groq/llama-3.3-70b-versatile");
  assert.equal(groqModel.authType, "apikey");

  const ollamaModel = models.find((m) => m.id === "ollama/qwen2.5-coder");
  assert.equal(ollamaModel.authType, "none");
});

test("getAllModelsFromRegistry: returns empty array for empty registry", () => {
  const models = getAllModelsFromRegistry({});
  assert.deepEqual(models, []);
});

// ═══════════════════════════════════════════════════════════════
//  buildAuthHeaders
// ═══════════════════════════════════════════════════════════════

test("buildAuthHeaders: returns Bearer header for bearer authHeader", () => {
  const headers = buildAuthHeaders(MOCK_REGISTRY.nvidia, "my-api-key");
  assert.deepEqual(headers, { Authorization: "Bearer my-api-key" });
});

test("buildAuthHeaders: returns empty object for authType none", () => {
  const headers = buildAuthHeaders(MOCK_REGISTRY.ollama, "any-token");
  assert.deepEqual(headers, {});
});

test("buildAuthHeaders: returns empty object for null token", () => {
  const headers = buildAuthHeaders(MOCK_REGISTRY.nvidia, null);
  assert.deepEqual(headers, {});
});

test("buildAuthHeaders: returns Token header for token authHeader", () => {
  const provider = { ...MOCK_REGISTRY.nvidia, authHeader: "token", authType: "apikey" };
  const headers = buildAuthHeaders(provider, "hf-token");
  assert.deepEqual(headers, { Authorization: "Token hf-token" });
});

test("buildAuthHeaders: returns Key header for key authHeader", () => {
  const provider = { ...MOCK_REGISTRY.nvidia, authHeader: "key", authType: "apikey" };
  const headers = buildAuthHeaders(provider, "maritalk-key");
  assert.deepEqual(headers, { Authorization: "Key maritalk-key" });
});

test("buildAuthHeaders: returns x-api-key header", () => {
  const provider = { ...MOCK_REGISTRY.nvidia, authHeader: "x-api-key", authType: "apikey" };
  const headers = buildAuthHeaders(provider, "custom-key");
  assert.deepEqual(headers, { "x-api-key": "custom-key" });
});

test("buildAuthHeaders: returns x-custom-key header", () => {
  const provider = { ...MOCK_REGISTRY.nvidia, authHeader: "xi-api-key", authType: "apikey" };
  const headers = buildAuthHeaders(provider, "xi-key");
  assert.deepEqual(headers, { "xi-api-key": "xi-key" });
});

test("buildAuthHeaders: returns empty object for authHeader none", () => {
  const provider = { ...MOCK_REGISTRY.nvidia, authHeader: "none", authType: "apikey" };
  const headers = buildAuthHeaders(provider, "some-token");
  assert.deepEqual(headers, {});
});

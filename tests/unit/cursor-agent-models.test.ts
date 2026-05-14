import test from "node:test";
import assert from "node:assert/strict";
import {
  humanizeCursorModelId,
  parseCursorAgentModels,
} from "../../src/lib/providerModels/cursorAgent";

test("parseCursorAgentModels handles legacy comma-separated format", () => {
  const text =
    "Cannot use this model: --help. Available models: auto, composer-2, composer-2-fast, gpt-5.3-codex-low, claude-opus-4-7-thinking-high, kimi-k2.5";
  assert.deepEqual(parseCursorAgentModels(text), [
    "auto",
    "composer-2",
    "composer-2-fast",
    "gpt-5.3-codex-low",
    "claude-opus-4-7-thinking-high",
    "kimi-k2.5",
  ]);
});

test("parseCursorAgentModels handles new line-based format (2026.05+)", () => {
  const text = `Available models

auto - Auto
composer-2-fast - Composer 2 Fast (current, default)
composer-2 - Composer 2
gpt-5.3-codex-low - Codex 5.3 Low
claude-opus-4-7-thinking-high - Opus 4.7 1M High Thinking
kimi-k2.5 - Kimi K2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`;
  assert.deepEqual(parseCursorAgentModels(text), [
    "auto",
    "composer-2-fast",
    "composer-2",
    "gpt-5.3-codex-low",
    "claude-opus-4-7-thinking-high",
    "kimi-k2.5",
  ]);
});

test("parseCursorAgentModels deduplicates and trims (legacy)", () => {
  assert.deepEqual(parseCursorAgentModels("Available models: a, a , b"), ["a", "b"]);
});

test("parseCursorAgentModels stops at 'Tip:' line", () => {
  const text = `Available models

auto - Auto
foo-1 - Foo

Tip: use --model
bar-2 - Bar
`;
  assert.deepEqual(parseCursorAgentModels(text), ["auto", "foo-1"]);
});

test("parseCursorAgentModels returns [] when the marker is missing", () => {
  assert.deepEqual(parseCursorAgentModels("nothing here"), []);
});

test("parseCursorAgentModels strips ANSI escape codes (real cursor-agent output)", () => {
  // Real captured output from cursor-agent 2026.05+ has SGR escapes around the
  // header (\u001b[2m...\u001b[22m for dim) and around model ids (\u001b[36m for
  // cyan, \u001b[32m for green) plus dim styling on display names.
  const text =
    "\u001b[2mAvailable models\u001b[22m\n\n" +
    "\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m\n" +
    "\u001b[32mcomposer-2-fast\u001b[39m \u001b[2m- Composer 2 Fast\u001b[22m\u001b[2m (current, default)\u001b[22m\n" +
    "\u001b[36mcomposer-2\u001b[39m \u001b[2m- Composer 2\u001b[22m\n" +
    "\u001b[36mgpt-5.3-codex-low\u001b[39m \u001b[2m- Codex 5.3 Low\u001b[22m\n" +
    "\u001b[36mkimi-k2.5\u001b[39m \u001b[2m- Kimi K2.5\u001b[22m\n\n" +
    "\u001b[2mTip: use --model <id> ...\u001b[22m\n";
  assert.deepEqual(parseCursorAgentModels(text), [
    "auto",
    "composer-2-fast",
    "composer-2",
    "gpt-5.3-codex-low",
    "kimi-k2.5",
  ]);
});

test("humanizeCursorModelId pretty-prints common patterns", () => {
  assert.equal(humanizeCursorModelId("auto"), "Auto (Server Picks)");
  assert.equal(humanizeCursorModelId("composer-2-fast"), "Composer 2 Fast");
  assert.equal(humanizeCursorModelId("gpt-5.3-codex-low"), "GPT 5.3 Codex Low");
  assert.equal(humanizeCursorModelId("gpt-5.5-extra-high-fast"), "GPT 5.5 Extra High Fast");
  // Collapses claude-opus-4-7-* version pattern into 4.7
  assert.equal(
    humanizeCursorModelId("claude-opus-4-7-thinking-high"),
    "Claude Opus 4.7 Thinking High"
  );
  assert.equal(humanizeCursorModelId("kimi-k2.5"), "Kimi K2.5");
  assert.equal(humanizeCursorModelId("gemini-3.1-pro"), "Gemini 3.1 Pro");
  assert.equal(humanizeCursorModelId("claude-4-sonnet-thinking"), "Claude 4 Sonnet Thinking");
});

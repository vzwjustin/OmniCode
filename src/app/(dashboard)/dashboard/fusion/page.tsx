"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";

type FusionMode = "fast" | "balanced" | "deep" | "code";

interface LocalCliAdapter {
  cmd: string;
  args: string[];
}

interface LocalCliConfig {
  claudeCode: LocalCliAdapter;
  codex: LocalCliAdapter;
  gemini: LocalCliAdapter;
  timeoutMs: number;
}

interface FusionConfigPayload {
  analysisModels: string[];
  judgeModel: string | null;
  criticModel: string | null;
  mode: FusionMode;
  temperature: number;
  maxTokens: number;
  enableCritique: boolean;
  enableCache: boolean;
  cacheTtlSeconds: number;
  perModelTimeoutMs: number;
  enabled: boolean;
  localCli: LocalCliConfig;
  updatedAt: number;
}

interface FusionConfigResponse {
  active: FusionConfigPayload;
  defaults: FusionConfigPayload;
}

interface TestRunResult {
  answer: string;
  latencyMs: number;
  meta: {
    mode: string;
    analysisModels: string[];
    judgeModel: string | null;
    criticModel: string | null;
    cached: boolean;
    judgeFailed: boolean;
    criticFailed: boolean;
    fallbackReason: string | null;
  };
  raw: unknown;
}

const PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  patch: Partial<FusionConfigPayload>;
}> = [
  {
    id: "remote-default",
    label: "Remote default",
    description: "Claude Sonnet + GPT-4.1 + Gemini → Claude Opus",
    patch: {
      analysisModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1", "google/gemini-2.5-pro"],
      judgeModel: "anthropic/claude-opus-4.1",
      criticModel: "anthropic/claude-sonnet-4.5",
      mode: "balanced",
      enableCritique: true,
    },
  },
  {
    id: "code-heavy",
    label: "Code-heavy",
    description: "Sonnet + GPT-4.1 + Gemini → Opus, mode=code",
    patch: {
      analysisModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1", "google/gemini-2.5-pro"],
      judgeModel: "anthropic/claude-opus-4.1",
      criticModel: null,
      mode: "code",
      enableCritique: false,
    },
  },
  {
    id: "deep-resolve",
    label: "Deep resolve",
    description: "mode=deep with critic; resolves contradictions explicitly",
    patch: {
      analysisModels: [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-4.1",
        "google/gemini-2.5-pro",
        "x-ai/grok-4",
      ],
      judgeModel: "anthropic/claude-opus-4.1",
      criticModel: "anthropic/claude-sonnet-4.5",
      mode: "deep",
      enableCritique: true,
    },
  },
  {
    id: "fast",
    label: "Fast",
    description: "Skip critique; judge synthesizes directly",
    patch: {
      mode: "fast",
      enableCritique: false,
    },
  },
  {
    id: "fully-local",
    label: "Fully local",
    description: "Claude Code + Codex + Gemini CLIs → Claude Code judge",
    patch: {
      analysisModels: ["local:claude-code", "local:codex", "local:gemini"],
      judgeModel: "local:claude-code",
      criticModel: null,
      mode: "balanced",
      enableCritique: false,
    },
  },
  {
    id: "local-analysis-remote-judge",
    label: "Local analysis, remote judge",
    description: "CLIs do the legwork; remote model judges",
    patch: {
      analysisModels: ["local:claude-code", "local:codex", "local:gemini"],
      judgeModel: "anthropic/claude-opus-4.1",
      criticModel: "anthropic/claude-sonnet-4.5",
      mode: "balanced",
      enableCritique: true,
    },
  },
];

function asInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function asFloat(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export default function FusionPage() {
  const notify = useNotificationStore((s) => s.addNotification);

  const [config, setConfig] = useState<FusionConfigPayload | null>(null);
  const [defaults, setDefaults] = useState<FusionConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testPrompt, setTestPrompt] = useState("");
  const [testModel, setTestModel] = useState("local-fusion");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/fusion-config", { credentials: "include" });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${r.status}`);
      }
      const body = (await r.json()) as FusionConfigResponse;
      setConfig(body.active);
      setDefaults(body.defaults);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const onSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const r = await fetch("/api/settings/fusion-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisModels: config.analysisModels,
          judgeModel: config.judgeModel,
          criticModel: config.criticModel,
          mode: config.mode,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          enableCritique: config.enableCritique,
          enableCache: config.enableCache,
          cacheTtlSeconds: config.cacheTtlSeconds,
          perModelTimeoutMs: config.perModelTimeoutMs,
          enabled: config.enabled,
          localCli: config.localCli,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${r.status}`);
      }
      const body = (await r.json()) as FusionConfigResponse;
      setConfig(body.active);
      notify({ type: "success", message: "Fusion config saved." });
    } catch (err) {
      notify({
        type: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setSaving(false);
    }
  }, [config, notify]);

  const onReset = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/settings/fusion-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as FusionConfigResponse;
      setConfig(body.active);
      notify({ type: "success", message: "Fusion config reset to defaults." });
    } catch (err) {
      notify({
        type: "error",
        message: err instanceof Error ? err.message : "Reset failed",
      });
    } finally {
      setSaving(false);
    }
  }, [notify]);

  const onApplyPreset = useCallback((preset: (typeof PRESETS)[number]) => {
    setConfig((prev) => (prev ? { ...prev, ...preset.patch } : prev));
  }, []);

  const onRunTest = useCallback(async () => {
    if (!testPrompt.trim()) {
      setTestError("Enter a prompt first.");
      return;
    }
    setTestRunning(true);
    setTestError(null);
    setTestResult(null);
    const t0 = performance.now();
    try {
      const r = await fetch("/v1/chat/completions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: testPrompt }],
          stream: false,
        }),
      });
      const text = await r.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      if (!r.ok) {
        throw new Error(
          (body?.error?.message as string) || `HTTP ${r.status}: ${text.slice(0, 200)}`
        );
      }
      const choice = body?.choices?.[0];
      const xlf = body?.x_local_fusion ?? {};
      setTestResult({
        answer: choice?.message?.content ?? "",
        latencyMs: Math.round(performance.now() - t0),
        meta: {
          mode: xlf.mode ?? "?",
          analysisModels: xlf.analysis_models ?? [],
          judgeModel: xlf.judge_model ?? null,
          criticModel: xlf.critic_model ?? null,
          cached: xlf.cached === true,
          judgeFailed: xlf.judge_failed === true,
          criticFailed: xlf.critic_failed === true,
          fallbackReason: xlf.fallback_reason ?? null,
        },
        raw: body,
      });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestRunning(false);
    }
  }, [testModel, testPrompt]);

  const analysisAsText = useMemo(() => (config ? config.analysisModels.join("\n") : ""), [config]);

  if (loading) {
    return <div className="p-6 text-text-muted">Loading fusion configuration…</div>;
  }

  if (!config) {
    return (
      <div className="p-6 text-red-500">
        Failed to load fusion configuration{error ? `: ${error}` : ""}.
        <button className="ml-3 underline" onClick={() => void loadConfig()} type="button">
          retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold">Local Fusion</h1>
        <p className="text-text-muted text-sm mt-1 max-w-3xl">
          Configure how OmniCode synthesizes one fused answer from multiple models. Coding tools
          (Claude Code, Codex, IDEs) that send chat completions with{" "}
          <code className="px-1.5 py-0.5 rounded bg-surface-raised/70 text-xs">local-fusion</code>{" "}
          will use these defaults transparently — the calling tool never sees the fusion happen.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <section className="rounded-xl border border-border/40 bg-surface-raised/40 p-5">
            <header className="flex items-center justify-between mb-4">
              <h2 className="text-base font-medium">Fusion defaults</h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                  Analysis models (one per line)
                </label>
                <textarea
                  value={analysisAsText}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      analysisModels: e.target.value
                        .split(/\r?\n|,/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={5}
                  className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                  placeholder={"anthropic/claude-sonnet-4.5\nopenai/gpt-4.1\ngoogle/gemini-2.5-pro"}
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                  Judge model
                </label>
                <input
                  type="text"
                  value={config.judgeModel ?? ""}
                  onChange={(e) =>
                    setConfig({ ...config, judgeModel: e.target.value.trim() || null })
                  }
                  className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                  Critic model (optional)
                </label>
                <input
                  type="text"
                  value={config.criticModel ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      criticModel: e.target.value.trim() || null,
                    })
                  }
                  className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                  Mode
                </label>
                <select
                  value={config.mode}
                  onChange={(e) => setConfig({ ...config, mode: e.target.value as FusionMode })}
                  className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                >
                  <option value="fast">fast — no critique, lowest latency</option>
                  <option value="balanced">balanced — default</option>
                  <option value="deep">deep — critic resolves contradictions</option>
                  <option value="code">code — implementation-ready output</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                    Temperature
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={config.temperature}
                    onChange={(e) =>
                      setConfig({ ...config, temperature: asFloat(e.target.value, 0.2) })
                    }
                    className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                    Max tokens
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={32000}
                    value={config.maxTokens}
                    onChange={(e) =>
                      setConfig({ ...config, maxTokens: asInt(e.target.value, 4000) })
                    }
                    className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                    Cache TTL (s)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={86400}
                    value={config.cacheTtlSeconds}
                    onChange={(e) =>
                      setConfig({ ...config, cacheTtlSeconds: asInt(e.target.value, 600) })
                    }
                    className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                    Per-model timeout (ms)
                  </label>
                  <input
                    type="number"
                    min={1000}
                    max={900000}
                    step={1000}
                    value={config.perModelTimeoutMs}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        perModelTimeoutMs: asInt(e.target.value, 240000),
                      })
                    }
                    className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="md:col-span-2 flex flex-wrap gap-4 pt-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={config.enableCritique}
                    onChange={(e) => setConfig({ ...config, enableCritique: e.target.checked })}
                  />
                  Enable critique pass
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={config.enableCache}
                    onChange={(e) => setConfig({ ...config, enableCache: e.target.checked })}
                  />
                  Enable response cache
                </label>
              </div>
            </div>

            <footer className="flex items-center gap-3 mt-5 pt-4 border-t border-border/30">
              <button
                onClick={() => void onSave()}
                disabled={saving}
                type="button"
                className="px-4 py-2 rounded-md bg-accent text-white disabled:opacity-50 text-sm font-medium"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => void loadConfig()}
                disabled={saving || loading}
                type="button"
                className="px-3 py-2 rounded-md border border-border/40 text-sm"
              >
                Reload
              </button>
              <button
                onClick={() => void onReset()}
                disabled={saving}
                type="button"
                className="px-3 py-2 rounded-md border border-border/40 text-sm"
              >
                Reset to defaults
              </button>
              {defaults && config.updatedAt > 0 ? (
                <span className="text-xs text-text-muted ml-auto">
                  last saved {new Date(config.updatedAt * 1000).toLocaleString()}
                </span>
              ) : null}
            </footer>
          </section>

          <section className="rounded-xl border border-border/40 bg-surface-raised/40 p-5">
            <h2 className="text-base font-medium mb-3">Local CLIs as models</h2>
            <p className="text-xs text-text-muted mb-4">
              Use a locally installed CLI (Claude Code, Codex CLI, Gemini CLI, …) as a model.
              Reference them anywhere a model id is accepted via{" "}
              <code className="px-1.5 py-0.5 rounded bg-surface text-xs">local:claude-code</code>,{" "}
              <code className="px-1.5 py-0.5 rounded bg-surface text-xs">local:codex</code>, or{" "}
              <code className="px-1.5 py-0.5 rounded bg-surface text-xs">local:gemini</code>.
              Prompts are sent on stdin; no shell, no interpolation. Leave a command empty to
              disable that adapter.
            </p>
            {(["claudeCode", "codex", "gemini"] as const).map((slug) => {
              const label =
                slug === "claudeCode"
                  ? "Claude Code (local:claude-code)"
                  : slug === "codex"
                    ? "OpenAI Codex CLI (local:codex)"
                    : "Gemini CLI (local:gemini)";
              const adapter = config.localCli[slug];
              return (
                <div key={slug} className="mb-4 grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                      {label} — command
                    </label>
                    <input
                      type="text"
                      value={adapter.cmd}
                      placeholder="e.g. claude  (leave blank to disable)"
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          localCli: {
                            ...config.localCli,
                            [slug]: { ...adapter, cmd: e.target.value },
                          },
                        })
                      }
                      className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                      Args (comma- or space-separated)
                    </label>
                    <input
                      type="text"
                      value={adapter.args.join(" ")}
                      placeholder="e.g. -p --output-format text"
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          localCli: {
                            ...config.localCli,
                            [slug]: {
                              ...adapter,
                              args: e.target.value
                                .split(/[\s,]+/)
                                .map((s) => s.trim())
                                .filter((s) => s.length > 0),
                            },
                          },
                        })
                      }
                      className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                    />
                  </div>
                </div>
              );
            })}
            <div className="mt-2 max-w-xs">
              <label className="block text-xs uppercase tracking-wide text-text-muted mb-1">
                Per-CLI timeout (ms)
              </label>
              <input
                type="number"
                min={1000}
                max={900000}
                step={1000}
                value={config.localCli.timeoutMs}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    localCli: {
                      ...config.localCli,
                      timeoutMs: asInt(e.target.value, 240000),
                    },
                  })
                }
                className="w-full rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
              />
            </div>
            <p className="text-xs text-text-muted mt-3">
              Tip: list these ids in <b>Analysis models</b> above to make fusion use the local CLIs
              in parallel — or set <b>Judge model</b> to a <code>local:…</code> id to keep the whole
              run on your machine.
            </p>
          </section>

          <section className="rounded-xl border border-border/40 bg-surface-raised/40 p-5">
            <h2 className="text-base font-medium mb-3">Test prompt</h2>
            <p className="text-xs text-text-muted mb-3">
              Sends a request through{" "}
              <code className="px-1.5 py-0.5 rounded bg-surface text-xs">
                POST /v1/chat/completions
              </code>{" "}
              — the exact path your coding tool will use. Save the config first so the test uses the
              saved defaults.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 mb-3">
              <textarea
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                rows={3}
                className="rounded-md border border-border/40 bg-surface px-3 py-2 text-sm font-mono"
                placeholder="What would your editor send here?"
              />
              <div className="flex flex-col gap-2 min-w-[220px]">
                <select
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                  className="rounded-md border border-border/40 bg-surface px-3 py-2 text-sm"
                >
                  <option value="local-fusion">local-fusion (use config)</option>
                  <option value="local-fusion-fast">local-fusion-fast</option>
                  <option value="local-fusion-balanced">local-fusion-balanced</option>
                  <option value="local-fusion-deep">local-fusion-deep</option>
                  <option value="local-fusion-code">local-fusion-code</option>
                  {config.localCli.claudeCode.cmd ? (
                    <option value="local:claude-code">local:claude-code (direct)</option>
                  ) : null}
                  {config.localCli.codex.cmd ? (
                    <option value="local:codex">local:codex (direct)</option>
                  ) : null}
                  {config.localCli.gemini.cmd ? (
                    <option value="local:gemini">local:gemini (direct)</option>
                  ) : null}
                </select>
                <button
                  onClick={() => void onRunTest()}
                  disabled={testRunning}
                  type="button"
                  className="px-4 py-2 rounded-md bg-accent text-white disabled:opacity-50 text-sm font-medium"
                >
                  {testRunning ? "Running…" : "Run"}
                </button>
              </div>
            </div>
            {testError ? (
              <div className="text-sm text-red-400 border border-red-500/40 bg-red-500/10 rounded-md p-3 whitespace-pre-wrap font-mono">
                {testError}
              </div>
            ) : null}
            {testResult ? (
              <div className="space-y-3">
                <div className="text-xs text-text-muted flex flex-wrap gap-4">
                  <span>
                    mode: <b>{testResult.meta.mode}</b>
                  </span>
                  <span>
                    judge: <b>{testResult.meta.judgeModel ?? "?"}</b>
                  </span>
                  <span>
                    critic: <b>{testResult.meta.criticModel ?? "—"}</b>
                  </span>
                  <span>
                    analysis: <b>{testResult.meta.analysisModels.length} models</b>
                  </span>
                  <span>
                    latency: <b>{testResult.latencyMs} ms</b>
                  </span>
                  {testResult.meta.cached ? <span>cached</span> : null}
                  {testResult.meta.judgeFailed ? (
                    <span className="text-amber-400">
                      judge fallback{" "}
                      {testResult.meta.fallbackReason ? `(${testResult.meta.fallbackReason})` : ""}
                    </span>
                  ) : null}
                  {testResult.meta.criticFailed ? (
                    <span className="text-amber-400">critic failed</span>
                  ) : null}
                </div>
                <pre className="rounded-md border border-border/40 bg-surface p-3 text-sm whitespace-pre-wrap font-mono">
                  {testResult.answer}
                </pre>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-border/40 bg-surface-raised/40 p-5">
            <h2 className="text-base font-medium mb-3">Quick presets</h2>
            <div className="flex flex-col gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onApplyPreset(preset)}
                  className="text-left rounded-md border border-border/30 bg-surface px-3 py-2 hover:border-accent/60 transition-colors"
                >
                  <div className="text-sm font-medium">{preset.label}</div>
                  <div className="text-xs text-text-muted mt-0.5">{preset.description}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-3">
              Applying a preset only fills the form — press <b>Save</b> to persist.
            </p>
          </section>

          <section className="rounded-xl border border-border/40 bg-surface-raised/40 p-5">
            <h2 className="text-base font-medium mb-3">How clients call this</h2>
            <pre className="text-xs whitespace-pre-wrap rounded-md bg-surface p-3 border border-border/30 font-mono">{`POST /v1/chat/completions
{
  "model": "local-fusion",
  "messages": [
    { "role": "user", "content": "…" }
  ]
}`}</pre>
            <p className="text-xs text-text-muted mt-3">
              Set your editor&apos;s OpenAI base URL to this server, key to a valid API key, and
              model to <code>local-fusion</code>. Inline syntax is also supported, e.g.{" "}
              <code>local-fusion-code:m1+m2@judge</code>.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

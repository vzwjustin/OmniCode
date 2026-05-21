/**
 * db/fusionConfig.ts — CRUD for the local-fusion orchestrator's active
 * configuration. Single row keyed by id="active" carrying a JSON blob.
 */

import { getDbInstance } from "./core";

export interface LocalCliAdapter {
  cmd: string;
  args: string[];
}

export interface LocalCliConfig {
  claudeCode: LocalCliAdapter;
  codex: LocalCliAdapter;
  gemini: LocalCliAdapter;
  timeoutMs: number;
}

export interface FusionConfigData {
  analysisModels: string[];
  judgeModel: string | null;
  criticModel: string | null;
  mode: "fast" | "balanced" | "deep" | "code";
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

const ACTIVE_ID = "active";

export const FUSION_CONFIG_DEFAULTS: FusionConfigData = {
  analysisModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1", "google/gemini-2.5-pro"],
  judgeModel: "anthropic/claude-opus-4.1",
  criticModel: "anthropic/claude-sonnet-4.5",
  mode: "balanced",
  temperature: 0.2,
  maxTokens: 4000,
  enableCritique: true,
  enableCache: true,
  cacheTtlSeconds: 600,
  perModelTimeoutMs: 240_000,
  enabled: true,
  localCli: {
    claudeCode: { cmd: "", args: [] },
    codex: { cmd: "", args: [] },
    gemini: { cmd: "", args: [] },
    timeoutMs: 240_000,
  },
  updatedAt: 0,
};

function normalizeAdapter(raw: unknown): LocalCliAdapter {
  if (!raw || typeof raw !== "object") return { cmd: "", args: [] };
  const r = raw as Partial<LocalCliAdapter>;
  const cmd = typeof r.cmd === "string" ? r.cmd.trim() : "";
  const args = Array.isArray(r.args)
    ? r.args.map((a) => String(a)).filter((a) => a.length > 0)
    : [];
  return { cmd, args };
}

function normalizeLocalCli(raw: unknown): LocalCliConfig {
  if (!raw || typeof raw !== "object") return { ...FUSION_CONFIG_DEFAULTS.localCli };
  const r = raw as Partial<LocalCliConfig>;
  return {
    claudeCode: normalizeAdapter((r as { claudeCode?: unknown }).claudeCode),
    codex: normalizeAdapter((r as { codex?: unknown }).codex),
    gemini: normalizeAdapter((r as { gemini?: unknown }).gemini),
    timeoutMs:
      typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0
        ? Math.min(15 * 60 * 1000, Math.floor(r.timeoutMs))
        : FUSION_CONFIG_DEFAULTS.localCli.timeoutMs,
  };
}

function normalize(raw: Partial<FusionConfigData> | null | undefined): FusionConfigData {
  const r = raw ?? {};
  const allowedModes = new Set(["fast", "balanced", "deep", "code"]);
  const mode = allowedModes.has(String(r.mode))
    ? (r.mode as FusionConfigData["mode"])
    : FUSION_CONFIG_DEFAULTS.mode;
  const analysisModels = Array.isArray(r.analysisModels)
    ? r.analysisModels.map((m) => String(m).trim()).filter((m) => m.length > 0)
    : [...FUSION_CONFIG_DEFAULTS.analysisModels];
  return {
    analysisModels:
      analysisModels.length > 0 ? analysisModels : [...FUSION_CONFIG_DEFAULTS.analysisModels],
    judgeModel:
      typeof r.judgeModel === "string" && r.judgeModel.trim().length > 0
        ? r.judgeModel.trim()
        : FUSION_CONFIG_DEFAULTS.judgeModel,
    criticModel:
      typeof r.criticModel === "string" && r.criticModel.trim().length > 0
        ? r.criticModel.trim()
        : null,
    mode,
    temperature:
      typeof r.temperature === "number" && Number.isFinite(r.temperature)
        ? Math.max(0, Math.min(2, r.temperature))
        : FUSION_CONFIG_DEFAULTS.temperature,
    maxTokens:
      typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens) && r.maxTokens > 0
        ? Math.min(32_000, Math.floor(r.maxTokens))
        : FUSION_CONFIG_DEFAULTS.maxTokens,
    enableCritique:
      typeof r.enableCritique === "boolean"
        ? r.enableCritique
        : FUSION_CONFIG_DEFAULTS.enableCritique,
    enableCache:
      typeof r.enableCache === "boolean" ? r.enableCache : FUSION_CONFIG_DEFAULTS.enableCache,
    cacheTtlSeconds:
      typeof r.cacheTtlSeconds === "number" &&
      Number.isFinite(r.cacheTtlSeconds) &&
      r.cacheTtlSeconds >= 0
        ? Math.min(24 * 60 * 60, Math.floor(r.cacheTtlSeconds))
        : FUSION_CONFIG_DEFAULTS.cacheTtlSeconds,
    perModelTimeoutMs:
      typeof r.perModelTimeoutMs === "number" &&
      Number.isFinite(r.perModelTimeoutMs) &&
      r.perModelTimeoutMs > 0
        ? Math.min(15 * 60 * 1000, Math.floor(r.perModelTimeoutMs))
        : FUSION_CONFIG_DEFAULTS.perModelTimeoutMs,
    enabled: typeof r.enabled === "boolean" ? r.enabled : FUSION_CONFIG_DEFAULTS.enabled,
    localCli: normalizeLocalCli((r as { localCli?: unknown }).localCli),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

export function getFusionConfig(): FusionConfigData {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT data, updated_at FROM fusion_config WHERE id = ?")
    .get(ACTIVE_ID) as { data?: string; updated_at?: number } | undefined;

  if (!row || typeof row.data !== "string") {
    return { ...FUSION_CONFIG_DEFAULTS };
  }
  let parsed: Partial<FusionConfigData> | null;
  try {
    parsed = JSON.parse(row.data) as Partial<FusionConfigData>;
  } catch {
    parsed = null;
  }
  const normalized = normalize(parsed);
  if (typeof row.updated_at === "number") {
    normalized.updatedAt = row.updated_at;
  }
  return normalized;
}

export function setFusionConfig(patch: Partial<FusionConfigData>): FusionConfigData {
  const db = getDbInstance();
  const current = getFusionConfig();
  const merged = normalize({ ...current, ...patch });
  const now = Math.floor(Date.now() / 1000);
  merged.updatedAt = now;

  db.prepare(
    `INSERT INTO fusion_config (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(ACTIVE_ID, JSON.stringify(merged), now);

  return merged;
}

export function resetFusionConfig(): FusionConfigData {
  const db = getDbInstance();
  db.prepare("DELETE FROM fusion_config WHERE id = ?").run(ACTIVE_ID);
  return { ...FUSION_CONFIG_DEFAULTS };
}

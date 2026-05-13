import { skillRegistry } from "./registry";
import { SkillExecution, SkillStatus, SkillHandler } from "./types";
import { getDbInstance } from "../db/core";
import { getSettings } from "../db/settings";
import { randomUUID } from "crypto";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("SKILLS_EXECUTOR");

function resolveSkillConcurrency(): number {
  const raw = process.env.OMNIROUTE_SKILL_MAX_CONCURRENT_PER_KEY;
  const parsed = raw ? Number.parseInt(raw, 10) : 8;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 128) return 8;
  return parsed;
}

class SkillExecutor {
  private static instance: SkillExecutor;
  private handlers: Map<string, SkillHandler> = new Map();
  private timeout: number = 30000;
  private maxRetries: number = 3;
  // Concurrency cap: protects the gateway from runaway parallel skill calls
  // (e.g. a model emitting many tool_calls in one response that each invoke a
  // sandboxed skill). Per-apiKey counter, configurable via env.
  private maxConcurrentPerKey: number = resolveSkillConcurrency();
  private inflightByKey: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): SkillExecutor {
    if (!SkillExecutor.instance) {
      SkillExecutor.instance = new SkillExecutor();
    }
    return SkillExecutor.instance;
  }

  registerHandler(name: string, handler: SkillHandler): void {
    this.handlers.set(name, handler);
  }

  setTimeout(ms: number): void {
    this.timeout = ms;
  }

  setMaxRetries(count: number): void {
    this.maxRetries = count;
  }

  async execute(
    skillName: string,
    input: Record<string, unknown>,
    context: { apiKeyId: string; sessionId?: string }
  ): Promise<SkillExecution> {
    const settings = await getSettings();
    if (settings.skillsEnabled === false) {
      throw new Error("Skills execution is disabled. Enable Skills in Settings > AI.");
    }

    const skill = skillRegistry.getSkill(skillName, context.apiKeyId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    if (!skill.enabled) {
      throw new Error(`Skill is disabled: ${skillName}`);
    }

    const db = getDbInstance();
    const executionId = randomUUID();
    const startTime = Date.now();

    // Per-tenant concurrency cap. If exceeded, reject the call rather than
    // queue indefinitely — callers (model tool_call loops) handle errors and
    // back off; an unbounded queue would consume memory.
    const inflight = this.inflightByKey.get(context.apiKeyId) ?? 0;
    if (inflight >= this.maxConcurrentPerKey) {
      throw new Error(
        `Skill concurrency limit reached for this API key (${inflight}/${this.maxConcurrentPerKey}). Retry shortly.`
      );
    }
    this.inflightByKey.set(context.apiKeyId, inflight + 1);

    log.info("skills.executor.start", { skillId: skill.id, skillName, apiKeyId: context.apiKeyId });

    try {
      db.prepare(
        `INSERT INTO skill_executions (id, skill_id, api_key_id, session_id, input, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        executionId,
        skill.id,
        context.apiKeyId,
        context.sessionId || null,
        JSON.stringify(input),
        SkillStatus.RUNNING,
        new Date().toISOString()
      );

      const handler = this.handlers.get(skill.handler);
      if (!handler) {
        throw new Error(`Handler not found: ${skill.handler}`);
      }

      let output: Record<string, unknown> | null = null;
      let errorMessage: string | null = null;
      let status = SkillStatus.SUCCESS;

      try {
        const result = await this.executeWithTimeout(
          handler(input, { apiKeyId: context.apiKeyId, sessionId: context.sessionId || "" })
        );
        output = result;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        status = SkillStatus.ERROR;
      }

      const durationMs = Date.now() - startTime;

      db.prepare(
        `UPDATE skill_executions SET output = ?, status = ?, error_message = ?, duration_ms = ? WHERE id = ?`
      ).run(output ? JSON.stringify(output) : null, status, errorMessage, durationMs, executionId);

      log.info("skills.executor.complete", {
        skillId: skill.id,
        success: status === SkillStatus.SUCCESS,
        durationMs,
      });

      return {
        id: executionId,
        skillId: skill.id,
        apiKeyId: context.apiKeyId,
        sessionId: context.sessionId || "",
        input,
        output,
        status,
        errorMessage,
        durationMs,
        createdAt: new Date(),
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      db.prepare(
        `UPDATE skill_executions SET status = ?, error_message = ?, duration_ms = ? WHERE id = ?`
      ).run(SkillStatus.ERROR, errorMessage, durationMs, executionId);

      throw err;
    } finally {
      // Release the inflight slot regardless of outcome
      const current = this.inflightByKey.get(context.apiKeyId) ?? 1;
      if (current <= 1) this.inflightByKey.delete(context.apiKeyId);
      else this.inflightByKey.set(context.apiKeyId, current - 1);
    }
  }

  private async executeWithTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Skill execution timed out")),
            this.timeout
          );
        }),
      ]);
    } finally {
      // Clear the timeout once the handler resolves first; previously the
      // unclearable timer remained pending and (in long-running processes)
      // would accumulate up to one expired-timer scheduling slot per call.
      if (timer) clearTimeout(timer);
    }
  }

  getExecution(executionId: string): SkillExecution | undefined {
    const db = getDbInstance();
    const row = db.prepare("SELECT * FROM skill_executions WHERE id = ?").get(executionId) as any;
    if (!row) return undefined;

    return {
      id: row.id,
      skillId: row.skill_id,
      apiKeyId: row.api_key_id,
      sessionId: row.session_id || "",
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status as SkillStatus,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: new Date(row.created_at),
    };
  }

  listExecutions(apiKeyId?: string, limit: number = 50, offset: number = 0): SkillExecution[] {
    const db = getDbInstance();
    const rows = apiKeyId
      ? db
          .prepare(
            "SELECT * FROM skill_executions WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
          )
          .all(apiKeyId, limit, offset)
      : db
          .prepare("SELECT * FROM skill_executions ORDER BY created_at DESC LIMIT ? OFFSET ?")
          .all(limit, offset);

    return (rows as any[]).map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      apiKeyId: row.api_key_id,
      sessionId: row.session_id || "",
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status as SkillStatus,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: new Date(row.created_at),
    }));
  }

  countExecutions(apiKeyId?: string): number {
    const db = getDbInstance();
    const row = apiKeyId
      ? (db
          .prepare("SELECT COUNT(*) as count FROM skill_executions WHERE api_key_id = ?")
          .get(apiKeyId) as any)
      : (db.prepare("SELECT COUNT(*) as count FROM skill_executions").get() as any);
    return row?.count ?? 0;
  }
}

export const skillExecutor = SkillExecutor.getInstance();

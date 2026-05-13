import { z } from "zod";
import { skillRegistry } from "@/lib/skills/registry";
import { skillExecutor } from "@/lib/skills/executor";
import { resolveEffectiveApiKeyId } from "./memoryTools.ts";

type AuthInfoExtra = {
  authInfo?: {
    clientId?: string;
    scopes?: string[];
    extra?: Record<string, unknown>;
  };
};

// `apiKeyId` is intentionally NOT user-supplied here. It is resolved from the
// MCP auth context to prevent cross-tenant access.
export const SkillListSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const SkillEnableSchema = z.object({
  skillId: z.string(),
  enabled: z.boolean(),
});

export const SkillExecuteSchema = z.object({
  skillName: z.string(),
  input: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional(),
});

export const SkillExecutionsSchema = z.object({
  limit: z.number().int().positive().max(100).optional(),
});

export const skillTools = {
  omniroute_skills_list: {
    name: "omniroute_skills_list",
    description: "List all registered skills with optional filtering by name or enabled state",
    inputSchema: SkillListSchema,
    handler: async (args: z.infer<typeof SkillListSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      await skillRegistry.loadFromDatabase(apiKeyId);
      const skills = skillRegistry.list(apiKeyId);

      let filtered = skills;
      if (args.name) {
        filtered = filtered.filter((s) => s.name.includes(args.name!));
      }
      if (args.enabled !== undefined) {
        filtered = filtered.filter((s) => s.enabled === args.enabled);
      }

      return {
        skills: filtered.map((s) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.description,
          enabled: s.enabled,
          createdAt: s.createdAt.toISOString(),
        })),
        count: filtered.length,
      };
    },
  },

  omniroute_skills_enable: {
    name: "omniroute_skills_enable",
    description: "Enable or disable a specific skill by ID",
    inputSchema: SkillEnableSchema,
    handler: async (args: z.infer<typeof SkillEnableSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const skill = skillRegistry.getSkill(args.skillId, apiKeyId);
      if (!skill) {
        throw new Error(`Skill not found: ${args.skillId}`);
      }

      await skillRegistry.register({
        ...skill,
        enabled: args.enabled,
        apiKeyId,
      });

      return { success: true, skillId: args.skillId, enabled: args.enabled };
    },
  },

  omniroute_skills_execute: {
    name: "omniroute_skills_execute",
    description: "Execute a skill with provided input and return the result",
    inputSchema: SkillExecuteSchema,
    handler: async (args: z.infer<typeof SkillExecuteSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const execution = await skillExecutor.execute(args.skillName, args.input, {
        apiKeyId,
        sessionId: args.sessionId,
      });

      return {
        id: execution.id,
        skillId: execution.skillId,
        status: execution.status,
        output: execution.output,
        error: execution.errorMessage,
        duration: execution.durationMs,
        createdAt: execution.createdAt.toISOString(),
      };
    },
  },

  omniroute_skills_executions: {
    name: "omniroute_skills_executions",
    description: "List recent skill execution history",
    inputSchema: SkillExecutionsSchema,
    handler: async (args: z.infer<typeof SkillExecutionsSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const executions = skillExecutor.listExecutions(apiKeyId, args.limit || 50);

      return {
        executions: executions.map((e) => ({
          id: e.id,
          skillId: e.skillId,
          status: e.status,
          duration: e.durationMs,
          error: e.errorMessage,
          createdAt: e.createdAt.toISOString(),
        })),
        count: executions.length,
      };
    },
  },
};

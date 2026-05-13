import { z } from "zod";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { createMemory, deleteMemory, listMemories } from "@/lib/memory/store";
import { MemoryType } from "@/lib/memory/types";

/**
 * Resolve the effective tenant `apiKeyId` for an MCP tool call.
 *
 * Precedence:
 *   1. `extra.authInfo.extra.apiKeyId` (token-bound tenant claim) or `extra.authInfo.clientId`
 *   2. `OMNIROUTE_API_KEY_ID` env (server-configured key id)
 *
 * The caller-supplied `apiKeyId` input is intentionally IGNORED to prevent
 * cross-tenant data access from any MCP client.
 */
type AuthInfoExtra = {
  authInfo?: {
    clientId?: string;
    scopes?: string[];
    extra?: Record<string, unknown>;
  };
};

export function resolveEffectiveApiKeyId(extra: AuthInfoExtra | undefined): string {
  const fromAuthExtra = extra?.authInfo?.extra?.apiKeyId;
  if (typeof fromAuthExtra === "string" && fromAuthExtra.trim()) {
    return fromAuthExtra.trim();
  }
  const fromClientId = extra?.authInfo?.clientId;
  if (typeof fromClientId === "string" && fromClientId.trim()) {
    return fromClientId.trim();
  }
  const fromEnv = process.env.OMNIROUTE_API_KEY_ID;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  throw new Error(
    "Tenant binding unavailable: no authInfo.apiKeyId/clientId and OMNIROUTE_API_KEY_ID is not set."
  );
}

// Note: `apiKeyId` is intentionally NOT part of the user-facing schemas. The
// effective tenant id is resolved from the MCP transport's auth context.
export const MemorySearchSchema = z.object({
  query: z.string().optional(),
  type: z.enum(["factual", "episodic", "procedural", "semantic"]).optional(),
  maxTokens: z.number().int().positive().max(8000).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const MemoryAddSchema = z.object({
  sessionId: z.string().optional(),
  type: z.enum(["factual", "episodic", "procedural", "semantic"]),
  key: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MemoryClearSchema = z.object({
  type: z.enum(["factual", "episodic", "procedural", "semantic"]).optional(),
  olderThan: z.string().optional(),
});

export const memoryTools = {
  omniroute_memory_search: {
    name: "omniroute_memory_search",
    description: "Search memories by query, type, or API key with token budget enforcement",
    inputSchema: MemorySearchSchema,
    handler: async (args: z.infer<typeof MemorySearchSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const config = {
        enabled: true,
        maxTokens: args.maxTokens || 2000,
        retrievalStrategy: "exact" as const,
        autoSummarize: false,
        persistAcrossModels: false,
        retentionDays: 30,
        scope: "apiKey" as const,
        query: args.query,
      };

      const memories = await retrieveMemories(apiKeyId, config);

      const filtered = args.type ? memories.filter((m) => m.type === args.type) : memories;

      const limited = args.limit ? filtered.slice(0, args.limit) : filtered;

      return {
        success: true,
        data: {
          memories: limited,
          count: limited.length,
          totalTokens: limited.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
        },
      };
    },
  },

  omniroute_memory_add: {
    name: "omniroute_memory_add",
    description: "Add a new memory entry",
    inputSchema: MemoryAddSchema,
    handler: async (args: z.infer<typeof MemoryAddSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const memory = await createMemory({
        apiKeyId,
        sessionId: args.sessionId || "",
        type: args.type as MemoryType,
        key: args.key,
        content: args.content,
        metadata: args.metadata || {},
        expiresAt: null,
      });

      return {
        success: true,
        data: {
          memory,
          message: "Memory created successfully",
        },
      };
    },
  },

  omniroute_memory_clear: {
    name: "omniroute_memory_clear",
    description: "Clear memories for an API key, optionally filtered by type or age",
    inputSchema: MemoryClearSchema,
    handler: async (args: z.infer<typeof MemoryClearSchema>, extra?: AuthInfoExtra) => {
      const apiKeyId = resolveEffectiveApiKeyId(extra);
      const result = await listMemories({
        apiKeyId,
        type: args.type as MemoryType | undefined,
      });
      const existingMemories = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : [];

      let toDelete = existingMemories;
      if (args.olderThan) {
        const cutoff = new Date(args.olderThan);
        toDelete = existingMemories.filter((m) => new Date(m.createdAt) < cutoff);
      }

      let deletedCount = 0;
      for (const memory of toDelete) {
        await deleteMemory(memory.id);
        deletedCount++;
      }

      return {
        success: true,
        data: {
          deletedCount,
          message: `Cleared ${deletedCount} memories`,
        },
      };
    },
  },
};

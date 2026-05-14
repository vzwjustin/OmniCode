// Patch global fetch with proxy support (must be first)
import "./utils/proxyFetch.ts";

// Config
export {
  PROVIDERS,
  OAUTH_ENDPOINTS,
  CACHE_TTL,
  DEFAULT_MAX_TOKENS,
  CLAUDE_SYSTEM_PROMPT,
  COOLDOWN_MS,
  BACKOFF_CONFIG,
} from "./config/constants.ts";
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel,
  findModelName,
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
} from "./config/providerModels.ts";

// Translator
export { FORMATS } from "./translator/formats.ts";
export {
  register,
  translateRequest,
  translateResponse,
  needsTranslation,
  initState,
  initTranslators,
} from "./translator/index.ts";

// Services
export {
  detectFormat,
  detectFormatFromEndpoint,
  getProviderConfig,
  buildProviderUrl,
  buildProviderHeaders,
  getTargetFormat,
} from "./services/provider.ts";

export { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "./services/model.ts";

export {
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil,
  filterAvailableAccounts,
  isProviderInCooldown,
  getProviderCooldownRemainingMs,
  getProvidersInCooldown,
} from "./services/accountFallback.ts";

export {
  TOKEN_EXPIRY_BUFFER_MS,
  refreshAccessToken,
  refreshClaudeOAuthToken,
  refreshGoogleToken,
  refreshQwenToken,
  refreshCodexToken,
  refreshQoderToken,
  refreshGitHubToken,
  refreshCopilotToken,
  getAccessToken,
  refreshTokenByProvider,
} from "./services/tokenRefresh.ts";

// Handlers
export { handleChatCore, isTokenExpiringSoon } from "./handlers/chatCore.ts";
export {
  createStreamController,
  pipeWithDisconnect,
  createDisconnectAwareStream,
} from "./utils/streamHandler.ts";

// Executors
export { getExecutor, hasSpecializedExecutor } from "./executors/index.ts";

// Utils
export { errorResponse, formatProviderError } from "./utils/error.ts";
export {
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger,
} from "./utils/stream.ts";

// Embeddings
export { handleEmbedding } from "./handlers/embeddings.ts";
export {
  EMBEDDING_PROVIDERS,
  getEmbeddingProvider,
  parseEmbeddingModel,
  getAllEmbeddingModels,
} from "./config/embeddingRegistry.ts";

// Think Tag Parser
export {
  hasThinkTags,
  extractThinkTags,
  processStreamingThinkDelta,
  flushThinkBuffer,
} from "./utils/thinkTagParser.ts";

// Rerank
export { handleRerank } from "./handlers/rerank.ts";
export {
  RERANK_PROVIDERS,
  getRerankProvider,
  parseRerankModel,
  getAllRerankModels,
} from "./config/rerankRegistry.ts";

// Moderations
export { handleModeration } from "./handlers/moderations.ts";
export {
  MODERATION_PROVIDERS,
  getModerationProvider,
  parseModerationModel,
  getAllModerationModels,
} from "./config/moderationRegistry.ts";

// Registry Utilities
export {
  parseModelFromRegistry,
  getAllModelsFromRegistry,
  buildAuthHeaders,
} from "./config/registryUtils.ts";

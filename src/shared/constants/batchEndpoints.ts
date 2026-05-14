export const SUPPORTED_BATCH_ENDPOINTS = [
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/completions",
  "/v1/moderations",
] as const;

export type SupportedBatchEndpoint = (typeof SUPPORTED_BATCH_ENDPOINTS)[number];

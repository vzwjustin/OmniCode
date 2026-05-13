import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getModelTargetFormat } from "../config/providerModels.ts";

export class OpencodeExecutor extends BaseExecutor {
  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  resolveRequestFormat(model: string): string {
    return getModelTargetFormat(this.provider, model) || "openai";
  }

  async execute(input: ExecuteInput) {
    return await super.execute(input);
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ) {
    void urlIndex;
    void credentials;

    const base = this.config.baseUrl;
    const requestFormat = this.resolveRequestFormat(model);
    switch (requestFormat) {
      case "claude":
        return `${base}/messages`;
      case "openai-responses":
        return `${base}/responses`;
      case "gemini":
        return `${base}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default:
        return `${base}/chat/completions`;
    }
  }

  buildHeaders(
    credentials: ProviderCredentials | null,
    stream = true,
    _clientHeaders?: Record<string, string> | null,
    model?: string
  ) {
    void _clientHeaders;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = credentials?.apiKey || credentials?.accessToken;
    const requestFormat = model ? this.resolveRequestFormat(model) : "openai";

    if (key) {
      if (requestFormat === "claude") {
        headers["x-api-key"] = key;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }

    if (requestFormat === "claude") {
      headers["anthropic-version"] = "2023-06-01";
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  transformRequest(
    model: string,
    body: any,
    stream: boolean,
    credentials: ProviderCredentials
  ): any {
    const modifiedBody = super.transformRequest(model, body, stream, credentials);
    if (
      modifiedBody &&
      typeof modifiedBody === "object" &&
      Array.isArray(modifiedBody.tools) &&
      modifiedBody.tools.length > 128
    ) {
      modifiedBody.tools = modifiedBody.tools.slice(0, 128);
    }
    return modifiedBody;
  }
}

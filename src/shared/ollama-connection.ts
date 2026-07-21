export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/v1";
export const DEFAULT_OLLAMA_EMBEDDING_BASE_URL = "http://localhost:11434";

export interface OllamaConnection {
  /** OpenAI-compatible API base, e.g. https://ollama.com/v1. */
  openAIBaseUrl: string;
  /** Bearer authentication required by direct ollama.com requests. */
  authorizationHeaders: Record<string, string>;
}

/**
 * Accept the Ollama Cloud host or either API-family suffix and normalize it to
 * the OpenAI-compatible `/v1` endpoint used throughout ScholarPen.
 */
export function resolveOllamaConnection(
  configuredBaseUrl: string | undefined,
  apiKey = "",
): OllamaConnection {
  const trimmed = (configuredBaseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const defaultHostUrl = DEFAULT_OLLAMA_BASE_URL.replace(/\/v1$/i, "");
  const hostUrl = trimmed.replace(/\/(?:api|v1)$/i, "") || defaultHostUrl;
  const normalizedApiKey = apiKey.trim();

  return {
    openAIBaseUrl: `${hostUrl}/v1`,
    authorizationHeaders: normalizedApiKey
      ? { Authorization: `Bearer ${normalizedApiKey}` }
      : {},
  };
}

/** Local Ollama remains a separate dependency for embedding-only workloads. */
export function resolveOllamaEmbeddingApiBaseUrl(
  configuredBaseUrl: string | undefined,
): string {
  const trimmed = (
    configuredBaseUrl?.trim() || DEFAULT_OLLAMA_EMBEDDING_BASE_URL
  ).replace(/\/+$/, "");
  const hostUrl = trimmed.replace(/\/api$/i, "") || DEFAULT_OLLAMA_EMBEDDING_BASE_URL;
  return `${hostUrl}/api`;
}

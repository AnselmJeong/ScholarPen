import type { OllamaChatRequest, OllamaStatus } from "../../shared/rpc-types";
import { resolveOllamaEmbeddingApiBaseUrl } from "../../shared/ollama-connection";
import { fileSystem } from "../fs/manager";
import { listProviderModels, streamAgentModel } from "../agent/providers";

const DEFAULT_MODEL = "qwen3.5:397b";

class OllamaClient {
  private defaultModel: string;

  constructor(defaultModel = DEFAULT_MODEL) {
    this.defaultModel = defaultModel;
  }

  private async getRuntimeSettings() {
    const settings = await fileSystem.getSettings();
    const defaultModel = settings.ollamaDefaultModel || this.defaultModel;
    return { settings, defaultModel };
  }

  async getStatus(): Promise<OllamaStatus> {
    try {
      console.log("[OllamaClient] Checking status...");
      const { settings } = await this.getRuntimeSettings();
      const models = await listProviderModels("ollama", settings);
      console.log("[OllamaClient] Connected. Models:", models);
      const savedModel = settings?.ollamaDefaultModel;
      const activeModel =
        savedModel && models.includes(savedModel)
          ? savedModel
          : (models.find((m) => m.includes("qwen")) ?? models[0] ?? null);
      return { connected: true, models, activeModel };
    } catch (err) {
      console.error("[OllamaClient] Status check failed:", err);
      return { connected: false, models: [], activeModel: null };
    }
  }

  async streamChat(
    req: OllamaChatRequest,
    onChunk: (content: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { settings, defaultModel } = await this.getRuntimeSettings();
    const model = req.model || defaultModel;
    for await (const content of streamAgentModel({
      provider: "ollama",
      model,
      messages: req.messages,
      think: req.think,
      signal,
    }, settings)) {
      onChunk(content);
    }
  }

  async embed(text: string, model = "nomic-embed-text"): Promise<number[]> {
    const { settings } = await this.getRuntimeSettings();
    const embeddingApiBaseUrl = resolveOllamaEmbeddingApiBaseUrl(settings.ollamaEmbeddingBaseUrl);
    const res = await fetch(`${embeddingApiBaseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.ollamaEmbedModel || model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Embedding error: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json() as { embedding?: number[] };
    const embedding = data.embedding;
    if (!embedding) throw new Error("Ollama embedding response did not include an embedding.");
    return embedding;
  }
}

export const ollamaClient = new OllamaClient();

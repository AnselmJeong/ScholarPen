import type { OllamaChatRequest, OllamaStatus } from "../../shared/rpc-types";
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

}

export const ollamaClient = new OllamaClient();

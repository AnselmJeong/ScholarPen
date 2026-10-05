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

  /** Last status logged, so the 10-second poll only logs changes. */
  private lastLogged: string | null = null;

  private logOnce(key: string, log: () => void) {
    if (this.lastLogged === key) return;
    this.lastLogged = key;
    log();
  }

  async getStatus(): Promise<OllamaStatus> {
    try {
      const { settings } = await this.getRuntimeSettings();
      // No key yet is the normal state before the user fills in Settings, not an error.
      if (!settings.ollamaApiKey?.trim()) {
        this.logOnce("no-key", () => console.log("[OllamaClient] Not configured: add an Ollama API key in Settings."));
        return { connected: false, models: [], activeModel: null };
      }
      const models = await listProviderModels("ollama", settings);
      this.logOnce(`connected:${models.join(",")}`, () => console.log("[OllamaClient] Connected. Models:", models));
      const savedModel = settings?.ollamaDefaultModel;
      const activeModel =
        savedModel && models.includes(savedModel)
          ? savedModel
          : (models.find((m) => m.includes("qwen")) ?? models[0] ?? null);
      return { connected: true, models, activeModel };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logOnce(`failed:${message}`, () => console.error("[OllamaClient] Status check failed:", message));
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

import { Ollama } from "ollama";
import type { OllamaChatRequest, OllamaStatus } from "../../shared/rpc-types";
import { fileSystem } from "../fs/manager";

const OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.5:cloud";

class OllamaClient {
  private defaultModel: string;
  private baseUrl: string;

  constructor(defaultModel = DEFAULT_MODEL) {
    this.defaultModel = defaultModel;
    this.baseUrl = OLLAMA_BASE_URL;
  }

  private normalizeBaseUrl(baseUrl: string | undefined): string {
    return (baseUrl || OLLAMA_BASE_URL).replace(/\/$/, "");
  }

  private async getRuntimeSettings() {
    const settings = await fileSystem.getSettings().catch(() => null);
    const baseUrl = this.normalizeBaseUrl(settings?.ollamaBaseUrl);
    const defaultModel = settings?.ollamaDefaultModel || this.defaultModel;
    return { settings, baseUrl, defaultModel };
  }

  async getStatus(): Promise<OllamaStatus> {
    try {
      console.log("[OllamaClient] Checking status...");
      const { settings, baseUrl } = await this.getRuntimeSettings();
      this.baseUrl = baseUrl;
      const ollama = new Ollama({ host: baseUrl });
      const result = await ollama.list();
      const models = result.models.map((m) => m.name);
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
    const { baseUrl, defaultModel } = await this.getRuntimeSettings();
    this.baseUrl = baseUrl;
    const model = req.model || defaultModel;
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: true,
        // Default to disabling qwen3 thinking — otherwise content comes back empty.
        think: req.think ?? false,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama error: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          if (parsed.message?.content) {
            onChunk(parsed.message.content);
          }
          if (parsed.done) return;
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  async embed(text: string, model = "nomic-embed-text"): Promise<number[]> {
    const { baseUrl, settings } = await this.getRuntimeSettings();
    this.baseUrl = baseUrl;
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings?.ollamaEmbedModel || model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Embedding error: HTTP ${res.status}`);
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}

export const ollamaClient = new OllamaClient();

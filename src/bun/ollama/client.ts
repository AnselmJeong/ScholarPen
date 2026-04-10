import { Ollama } from "ollama";
import type { OllamaChatRequest, OllamaStatus } from "../../shared/rpc-types";
import { fileSystem } from "../fs/manager";

const OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.5:cloud";

const ollama = new Ollama({ host: OLLAMA_BASE_URL });

class OllamaClient {
  private defaultModel: string;
  private baseUrl: string;

  constructor(defaultModel = DEFAULT_MODEL) {
    this.defaultModel = defaultModel;
    this.baseUrl = OLLAMA_BASE_URL;
  }

  async getStatus(): Promise<OllamaStatus> {
    try {
      console.log("[OllamaClient] Checking status...");
      const [result, settings] = await Promise.all([
        ollama.list(),
        fileSystem.getSettings().catch(() => null),
      ]);
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
    onChunk: (content: string) => void
  ): Promise<void> {
    const model = req.model || this.defaultModel;
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: true,
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
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Embedding error: HTTP ${res.status}`);
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}

export const ollamaClient = new OllamaClient();

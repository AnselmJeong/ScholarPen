import type { AppSettings, LLMProvider, OllamaMessage } from "../../shared/rpc-types";
import { resolveOllamaConnection } from "../../shared/ollama-connection";

export interface AgentStreamRequest {
  provider: LLMProvider;
  model: string;
  messages: OllamaMessage[];
  think?: boolean;
  signal?: AbortSignal;
}

function ensureApiKey(provider: string, apiKey: string): string {
  if (!apiKey.trim()) throw new Error(`${provider} API key is not configured in Settings.`);
  return apiKey.trim();
}

async function* streamSse(response: Response): AsyncGenerator<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned an empty response body.");
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data);
      }
    }
  }
}

function splitSystem(messages: OllamaMessage[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system, messages: rest };
}

export async function* streamAgentModel(
  request: AgentStreamRequest,
  settings: AppSettings,
): AsyncGenerator<string> {
  if (request.provider === "ollama") {
    const apiKey = ensureApiKey("Ollama", settings.ollamaApiKey);
    const connection = resolveOllamaConnection(settings.ollamaBaseUrl, apiKey);
    const res = await fetch(`${connection.openAIBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...connection.authorizationHeaders,
      },
      body: JSON.stringify({
        model: request.model || settings.ollamaDefaultModel,
        messages: request.messages,
        stream: true,
        think: request.think ?? false,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Ollama error: HTTP ${res.status} ${await res.text()}`);
    for await (const json of streamSse(res)) {
      const text = json.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
    return;
  }

  if (request.provider === "anthropic") {
    const apiKey = ensureApiKey("Claude", settings.anthropicApiKey);
    const { system, messages } = splitSystem(request.messages);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model || settings.anthropicDefaultModel,
        max_tokens: 4096,
        system,
        messages,
        stream: true,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Claude API error: HTTP ${res.status} ${await res.text()}`);
    for await (const json of streamSse(res)) {
      const text = json.delta?.text;
      if (text) yield text;
    }
    return;
  }

  const isDeepSeek = request.provider === "deepseek";
  const apiKey = ensureApiKey(isDeepSeek ? "DeepSeek" : "OpenAI", isDeepSeek ? settings.deepseekApiKey : settings.openaiApiKey);
  const baseUrl = (isDeepSeek ? settings.deepseekBaseUrl : settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model || (isDeepSeek ? settings.deepseekDefaultModel : settings.openaiDefaultModel),
      messages: request.messages,
      stream: true,
    }),
    signal: request.signal,
  });
  if (!res.ok) throw new Error(`${isDeepSeek ? "DeepSeek" : "OpenAI"} API error: HTTP ${res.status} ${await res.text()}`);
  for await (const json of streamSse(res)) {
    const text = json.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

function normalizeModelIds(json: any): string[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  return data
    .map((item: { id?: unknown }) => item?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b));
}

export async function listProviderModels(provider: LLMProvider, settings: AppSettings): Promise<string[]> {
  if (provider === "ollama") {
    const apiKey = ensureApiKey("Ollama", settings.ollamaApiKey);
    const connection = resolveOllamaConnection(settings.ollamaBaseUrl, apiKey);
    const res = await fetch(`${connection.openAIBaseUrl}/models`, {
      headers: connection.authorizationHeaders,
    });
    if (!res.ok) throw new Error(`Ollama model list error: HTTP ${res.status} ${await res.text()}`);
    return normalizeModelIds(await res.json());
  }

  if (provider === "anthropic") {
    const apiKey = ensureApiKey("Claude", settings.anthropicApiKey);
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Claude model list error: HTTP ${res.status} ${await res.text()}`);
    return normalizeModelIds(await res.json());
  }

  const isDeepSeek = provider === "deepseek";
  const apiKey = ensureApiKey(isDeepSeek ? "DeepSeek" : "OpenAI", isDeepSeek ? settings.deepseekApiKey : settings.openaiApiKey);
  const baseUrl = (isDeepSeek ? settings.deepseekBaseUrl : settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) throw new Error(`${isDeepSeek ? "DeepSeek" : "OpenAI"} model list error: HTTP ${res.status} ${await res.text()}`);
  return normalizeModelIds(await res.json());
}

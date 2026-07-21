import { resolveOllamaConnection } from "../../shared/ollama-connection";
import { fileSystem } from "../fs/manager";

const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;

export function prepareOllamaChatRequestBody(body: string): string {
  if (new TextEncoder().encode(body).byteLength > MAX_PROXY_BODY_BYTES) {
    throw new Error("Ollama request body is too large.");
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;
  parsed.think = false;
  return JSON.stringify(parsed);
}

export async function openOllamaChatCompletion(
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const settings = await fileSystem.getSettings();
  const apiKey = settings.ollamaApiKey.trim();
  if (!apiKey) throw new Error("Ollama API key is not configured in Settings.");

  const connection = resolveOllamaConnection(settings.ollamaBaseUrl, apiKey);
  return fetch(`${connection.openAIBaseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...connection.authorizationHeaders,
    },
    body: prepareOllamaChatRequestBody(body),
  });
}

export async function pipeResponseText(
  response: Response,
  onChunk: (content: string) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const content = decoder.decode(value, { stream: true });
    if (content) onChunk(content);
  }

  const tail = decoder.decode();
  if (tail) onChunk(tail);
}

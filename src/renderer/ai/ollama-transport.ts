// Ollama transport for BlockNote AIExtension
// Uses ClientSideTransport with OpenAI Compatible provider

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ClientSideTransport } from "@blocknote/xl-ai/server";

/**
 * Creates a ClientSideTransport that calls Ollama directly from the webview.
 * Ollama must be running on localhost:11434.
 *
 * Note: Ollama needs CORS enabled. Run with:
 *   OLLAMA_ORIGINS="*" ollama serve
 */
export function createOllamaTransport(modelName: string) {
  console.log("[ollama-transport] Creating transport for model:", modelName);
  // Use OpenAI Compatible provider for Ollama
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama", // Ollama doesn't require API key, but provider needs one
  });
  const model = ollama(modelName);
  console.log("[ollama-transport] Model created:", typeof model);
  console.log("[ollama-transport] Model spec:", (model as any)?.specificationVersion);

  const transport = new ClientSideTransport({
    model,
    systemPrompt: "You are a helpful academic writing assistant. Help the user with their research writing tasks.",
    stream: true,
  });
  console.log("[ollama-transport] Transport created");
  return transport;
}

/**
 * Creates an Ollama transport with custom system prompt
 */
export function createOllamaTransportWithSystemPrompt(modelName: string, systemPrompt: string) {
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: "http://localhost:11434/v1",
  });
  const model = ollama(modelName);
  return new ClientSideTransport({
    model,
    systemPrompt,
    stream: true,
  });
}

/**
 * Creates a placeholder transport for when Ollama is not yet connected.
 *
 * IMPORTANT: never pass `model: null` to ClientSideTransport — BlockNote's
 * streamText() calls `model.specificationVersion` unconditionally, which
 * throws "null is not an object" and poisons the cached `chat` object for
 * the rest of the session.
 *
 * Using a real (non-null) model with a placeholder model ID is safe: if AI
 * is invoked before Ollama connects the call will fail with a network error
 * (connection refused), which BlockNote surfaces as a recoverable error state
 * rather than an uncaught crash.
 */
export function createNoOpTransport() {
  const ollama = createOpenAICompatible({
    name: "ollama-placeholder",
    baseURL: "http://localhost:11434/v1",
    apiKey: "none",
  });
  return new ClientSideTransport({
    model: ollama("placeholder"),
    systemPrompt: "You are a helpful assistant.",
    stream: true,
  });
}

// Ollama transport for BlockNote AIExtension
// Uses ClientSideTransport with OpenAI Compatible provider

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ClientSideTransport } from "@blocknote/xl-ai/server";
import { onOllamaProxyChunk, rpc } from "../rpc";

/**
 * Streams the OpenAI-compatible request through Bun. The Bun proxy injects
 * `think: false`, bypasses Cloud CORS restrictions, and keeps credentials out
 * of renderer-side network requests while preserving tool-call SSE events.
 */
const ollamaProxyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new Error("Ollama proxy expected a JSON request body.");
  }
  if (init.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const requestId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let detachListener = () => {};
  let detachAbort = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        detachListener();
        detachAbort();
      };

      detachListener = onOllamaProxyChunk((payload) => {
        if (payload.requestId !== requestId) return;
        if (payload.error) {
          cleanup();
          controller.error(new Error(payload.error));
          return;
        }
        if (payload.content) controller.enqueue(encoder.encode(payload.content));
        if (payload.done) {
          cleanup();
          controller.close();
        }
      });

      const abort = () => {
        cleanup();
        void rpc.abortOllamaOpenAIProxy(requestId).catch(() => {});
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (init.signal?.aborted) {
        abort();
      } else if (init.signal) {
        init.signal.addEventListener("abort", abort, { once: true });
        detachAbort = () => init.signal?.removeEventListener("abort", abort);
      }
    },
    cancel() {
      detachListener();
      detachAbort();
      void rpc.abortOllamaOpenAIProxy(requestId).catch(() => {});
    },
  });

  try {
    const response = await rpc.startOllamaOpenAIProxy(requestId, init.body);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": response.contentType },
    });
  } catch (error) {
    detachListener();
    detachAbort();
    throw error;
  }
}) as typeof fetch;

const unavailableFetch = (async () => {
  throw new Error("Ollama Cloud is not connected. Configure the API key in Settings.");
}) as unknown as typeof fetch;

export function createOllamaTransport(modelName: string) {
  console.log("[ollama-transport] Creating transport for model:", modelName);
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: "http://scholarpen.internal/v1",
    apiKey: "proxied-by-bun",
    fetch: ollamaProxyFetch,
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
export function createOllamaTransportWithSystemPrompt(
  modelName: string,
  systemPrompt: string,
) {
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: "http://scholarpen.internal/v1",
    apiKey: "proxied-by-bun",
    fetch: ollamaProxyFetch,
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
 * Using a real (non-null) model with a placeholder model ID is safe: the
 * placeholder fetch surfaces a recoverable configuration error if invoked.
 */
export function createNoOpTransport() {
  const ollama = createOpenAICompatible({
    name: "ollama-placeholder",
    baseURL: "http://scholarpen.internal/v1",
    apiKey: "none",
    fetch: unavailableFetch,
  });
  return new ClientSideTransport({
    model: ollama("placeholder"),
    systemPrompt: "You are a helpful assistant.",
    stream: true,
  });
}

import { describe, expect, test } from "bun:test";
import { resolveOllamaConnection } from "./ollama-connection";

describe("resolveOllamaConnection", () => {
  test("defaults to Ollama Cloud", () => {
    expect(resolveOllamaConnection(undefined)).toEqual({
      openAIBaseUrl: "https://ollama.com/v1",
      authorizationHeaders: {},
    });
  });

  test("does not duplicate a configured Ollama Cloud /v1 suffix", () => {
    expect(resolveOllamaConnection("https://ollama.com/v1/", " ollama-secret ")).toEqual({
      openAIBaseUrl: "https://ollama.com/v1",
      authorizationHeaders: { Authorization: "Bearer ollama-secret" },
    });
  });

  test("normalizes a native /api base to the Cloud /v1 endpoint", () => {
    const connection = resolveOllamaConnection("https://proxy.example.com/ollama/api");
    expect(connection.openAIBaseUrl).toBe("https://proxy.example.com/ollama/v1");
  });

  test("does not duplicate /v1 when only a suffix is supplied", () => {
    expect(resolveOllamaConnection("/v1").openAIBaseUrl).toBe("https://ollama.com/v1");
  });
});

import { describe, expect, test } from "bun:test";
import { normalizeSettings } from "./manager";

describe("settings migration", () => {
  test("migrates the legacy Ollama search toggle to provider-neutral web search", () => {
    const normalized = normalizeSettings({ ollamaWebSearchEnabled: false });

    expect(normalized.webSearchEnabled).toBeFalse();
    expect(normalized.tinyfishApiKey).toBe("");
    expect(normalized.openAlexApiKey).toBe("");
    expect(normalized.ncbiApiKey).toBe("");
    expect("ollamaWebSearchEnabled" in normalized).toBeFalse();
  });

  test("prefers explicitly saved TinyFish settings over the legacy toggle", () => {
    const normalized = normalizeSettings({
      ollamaWebSearchEnabled: false,
      webSearchEnabled: true,
      tinyfishApiKey: " tinyfish-key ",
    });

    expect(normalized.webSearchEnabled).toBeTrue();
    expect(normalized.tinyfishApiKey).toBe(" tinyfish-key ");
  });

  test("preserves scholarly search API keys", () => {
    const normalized = normalizeSettings({
      openAlexApiKey: " openalex-key ",
      ncbiApiKey: " ncbi-key ",
    });

    expect(normalized.openAlexApiKey).toBe(" openalex-key ");
    expect(normalized.ncbiApiKey).toBe(" ncbi-key ");
  });
});

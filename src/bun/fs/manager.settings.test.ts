import { describe, expect, test } from "bun:test";
import { normalizeSettings } from "./manager";

describe("settings migration", () => {
  test("adds Codex without changing an existing provider, model, or API key", () => {
    const settings = normalizeSettings({ sidebarAgentProvider: "openai", sidebarAgentModel: "saved-model", openaiApiKey: "existing-key" });
    expect(settings.sidebarAgentProvider).toBe("openai");
    expect(settings.sidebarAgentModel).toBe("saved-model");
    expect(settings.openaiApiKey).toBe("existing-key");
    expect(settings.modelProviders.codex).toEqual({ provider: "codex", model: "", enabled: true });
  });

  test("persists Codex selection including account-default model without falling back to Ollama", () => {
    const defaults = normalizeSettings({ sidebarAgentProvider: "codex" });
    expect(defaults.sidebarAgentModel).toBe("");
    const saved = normalizeSettings({ ...defaults, sidebarAgentModel: "codex-model", modelProviders: { ...defaults.modelProviders, codex: { provider: "codex", model: "codex-model", enabled: true } } });
    expect(normalizeSettings(JSON.parse(JSON.stringify(saved))).sidebarAgentModel).toBe("codex-model");
    expect(normalizeSettings({ ...saved, sidebarAgentModel: "" }).sidebarAgentModel).toBe("");
  });

  test("migrates the legacy Ollama search toggle to provider-neutral web search", () => {
    const normalized = normalizeSettings({ ollamaWebSearchEnabled: false });

    expect(normalized.webSearchEnabled).toBeFalse();
    expect(normalized.tinyfishApiKey).toBe("");
    expect(normalized.openAlexApiKey).toBe("");
    expect(normalized.ncbiApiKey).toBe("");
    expect(normalized.paperclipApiKey).toBe("");
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
      paperclipApiKey: " paperclip-test-key ",
    });

    expect(normalized.openAlexApiKey).toBe(" openalex-key ");
    expect(normalized.ncbiApiKey).toBe(" ncbi-key ");
    expect(normalized.paperclipApiKey).toBe("paperclip-test-key");
    expect(normalizeSettings(JSON.parse(JSON.stringify(normalized))).paperclipApiKey).toBe("paperclip-test-key");
  });
});

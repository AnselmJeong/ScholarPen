import { afterEach, describe, expect, test } from "bun:test";
import { normalizeSettings } from "../fs/manager";
import { buildAgentMessages } from "./context-builder";
import { streamAgentModel } from "./providers";
import { agentThinkingConfig } from "../../shared/agent-thinking";
import type { AgentStreamParams } from "../../shared/rpc-types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const settings = normalizeSettings({
  ollamaApiKey: "test-key", anthropicApiKey: "test-key", openaiApiKey: "test-key", deepseekApiKey: "test-key",
  webSearchEnabled: true,
});
const params: AgentStreamParams = {
  message: "Search for current autism research", projectPath: null, history: [],
  provider: "ollama", model: "qwen3.5:397b", selectedSkillIds: [], selectedFilePaths: [], lang: "ko",
};

describe("per-question search", () => {
  for (const searchEnabled of [undefined, false]) {
    test(`search=${searchEnabled} skips both decision and external retrieval even for an explicit search prompt`, async () => {
      const urls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        urls.push(String(url));
        throw new Error("Unexpected network request");
      }) as unknown as typeof fetch;
      const result = await buildAgentMessages({ ...params, searchEnabled }, settings);
      expect(urls).toEqual([]);
      expect(result.references).toBe("");
      expect(result.messages[0].content).toContain("Web search was not used");
    });
  }

  test("global search disabled skips even the decision/query model request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("Unexpected fetch"); }) as unknown as typeof fetch;
    const result = await buildAgentMessages({ ...params, searchEnabled: true }, { ...settings, webSearchEnabled: false });
    expect(calls).toBe(0);
    expect(result.messages[0].content).toContain("disabled in Settings");
  });

  test("search on generates a query and retrieves evidence without a classifier request", async () => {
    const urls: string[] = [];
    const prompts: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).includes("chat/completions")) {
        const body = JSON.parse(String(init?.body));
        prompts.push(body.messages[0].content);
        expect(body.reasoning_effort).toBe("none");
        return Response.json({ choices: [{ message: { content: "autism sensory processing" } }] });
      }
      if (String(url).includes("openalex")) return Response.json({ results: [] });
      if (String(url).includes("esearch")) return Response.json({ esearchresult: { idlist: [] } });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    await buildAgentMessages({ ...params, searchEnabled: true }, settings);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("NO_SEARCH");
    expect(urls.some(url => url.includes("openalex"))).toBeTrue();
    expect(urls.some(url => url.includes("esearch"))).toBeTrue();
  });

  test("explicit Find Citation still retrieves candidates when the ordinary search toggle is off", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes("chat/completions")) return Response.json({ choices: [{ message: { content: "autism sensory processing" } }] });
      if (String(url).includes("openalex")) return Response.json({ results: [] });
      return Response.json({ message: { items: [] } });
    }) as typeof fetch;
    await buildAgentMessages({ ...params, searchEnabled: false, analysisMode: "find-citation", citationContext: { selectedText: "Autism sensory processing" } }, settings);
    expect(urls.some(url => url.includes("openalex") || url.includes("crossref"))).toBeTrue();
  });
});

describe("provider thinking payloads and activity", () => {
  for (const level of ["none", "low", "medium", "high"] as const) {
    test(`Ollama sends ${level} through the OpenAI-compatible API`, async () => {
      let body: any;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response('data: {"choices":[{"delta":{"reasoning":"private reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n');
      }) as typeof fetch;
      const chunks = [];
      for await (const chunk of streamAgentModel({ provider: "ollama", model: params.model, messages: [], thinkingLevel: level }, settings)) chunks.push(chunk);
      expect(body.reasoning_effort).toBe(level);
      expect(body.think).toBeUndefined();
      expect(chunks).toEqual(["", "Answer"]);
    });
  }

  test("omitted thinking level is none", async () => {
    let body: any;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("data: [DONE]\n\n");
    }) as typeof fetch;
    for await (const _ of streamAgentModel({ provider: "ollama", model: params.model, messages: [] }, settings)) { /* drain */ }
    expect(body.reasoning_effort).toBe("none");
  });

  test("GPT-OSS none falls back to low with a visible explanation", () => {
    const config = agentThinkingConfig("ollama", "gpt-oss:120b", "none");
    expect(config.fields.reasoning_effort).toBe("low");
    expect(config.notice).toContain("Low");
  });

  test("OpenAI supported models use effort, older reasoning models have an explicit minimum, non-reasoning models omit it", () => {
    expect(agentThinkingConfig("openai", "gpt-5.2", "none").fields).toEqual({ reasoning_effort: "none" });
    expect(agentThinkingConfig("openai", "o3", "none").fields).toEqual({ reasoning_effort: "low" });
    expect(agentThinkingConfig("openai", "gpt-4o", "high").fields).toEqual({});
    expect(agentThinkingConfig("openai", "gpt-4o", "high").supported).toBeFalse();
  });

  test("Claude manual budgets leave room for the answer and new models use adaptive thinking", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const fields = agentThinkingConfig("anthropic", "claude-sonnet-4-5", level).fields as any;
      expect(fields.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      expect(fields.max_tokens).toBeGreaterThan(fields.thinking.budget_tokens);
      expect(agentThinkingConfig("anthropic", "claude-sonnet-4-6", level).fields.output_config).toEqual({ effort: level });
    }
    expect(agentThinkingConfig("anthropic", "claude-sonnet-4-6", "none").fields.thinking).toEqual({ type: "disabled" });
  });

  test("DeepSeek explicitly disables thinking and explains legacy model selection", () => {
    expect(agentThinkingConfig("deepseek", "deepseek-flash", "none").fields.thinking).toEqual({ type: "disabled" });
    expect(agentThinkingConfig("deepseek", "deepseek-chat", "high").fields.model).toBe("deepseek-reasoner");
    expect(agentThinkingConfig("deepseek", "deepseek-reasoner", "none").fields.model).toBe("deepseek-chat");
  });
});

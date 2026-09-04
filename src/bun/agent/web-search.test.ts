import { describe, expect, test } from "bun:test";
import {
  academicSourceScore,
  searchAndFetchWebWithTinyFish,
  searchWebWithTinyFish,
  prioritizeAcademicResults,
  type FetchLike,
  type WebSearchResult,
} from "./web-search";
import type { AppSettings } from "../../shared/rpc-types";

const settings = {
  projectsRootDir: "/tmp/ScholarPen",
  sidebarAgentProvider: "ollama",
  sidebarAgentModel: "qwen3.5:397b",
  modelProviders: {
    ollama: {
      provider: "ollama",
      model: "qwen3.5:397b",
      baseUrl: "https://ollama.com",
      enabled: true,
    },
    anthropic: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      enabled: false,
    },
    deepseek: {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      enabled: false,
    },
    openai: {
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      enabled: false,
    },
  },
  ollamaBaseUrl: "https://ollama.com",
  ollamaApiKey: "ollama-key",
  ollamaDefaultModel: "qwen3.5:397b",
  tinyfishApiKey: "tinyfish-key",
  webSearchEnabled: true,
  anthropicApiKey: "",
  anthropicDefaultModel: "claude-sonnet-4-5",
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekDefaultModel: "deepseek-chat",
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiDefaultModel: "gpt-5.2",
  openAlexApiKey: "",
  theme: "system",
} satisfies AppSettings;

describe("academic web-source priority", () => {
  const results: WebSearchResult[] = [
    {
      title: "자폐 아동 시각 착각 정리",
      url: "https://example.co.kr/blog/autism",
      content: "일반적인 웹 설명",
    },
    {
      title: "Susceptibility to visual illusions in autistic children",
      url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      content: "Journal article abstract with DOI 10.1000/example",
    },
    {
      title: "Preprint on contextual integration",
      url: "https://arxiv.org/abs/1234.5678",
      content: "Research article",
    },
  ];

  test("ranks English scholarly sources ahead of Korean general websites", () => {
    const ranked = prioritizeAcademicResults(results);
    expect(ranked[0].url).toContain("pubmed.ncbi.nlm.nih.gov");
    expect(ranked[1].url).toContain("arxiv.org");
    expect(ranked[2].url).toContain("example.co.kr");
  });

  test("assigns a materially higher score to academic databases", () => {
    expect(academicSourceScore(results[1])).toBeGreaterThan(academicSourceScore(results[0]));
  });
});

describe("TinyFish web search", () => {
  test("uses the Search API GET contract and maps structured snippets", async () => {
    const fetchFn: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.search.tinyfish.ai/");
      expect(url.searchParams.get("query")).toBe("predictive processing autism");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("tinyfish-key");
      expect(new Headers(init?.headers).has("Authorization")).toBeFalse();
      return Response.json({
        query: "predictive processing autism",
        results: [
          {
            position: 1,
            site_name: "Nature",
            title: "Predictive processing and autism",
            snippet: "A scholarly overview.",
            url: "https://www.nature.com/articles/example",
          },
          {
            position: 2,
            site_name: "Invalid",
            title: "Invalid protocol",
            snippet: "Ignored.",
            url: "file:///tmp/private",
          },
        ],
        total_results: 2,
        page: 0,
      });
    };

    await expect(
      searchWebWithTinyFish(" predictive processing autism ", settings, 5, undefined, fetchFn),
    ).resolves.toEqual([
      {
        title: "Predictive processing and autism",
        url: "https://www.nature.com/articles/example",
        content: "A scholarly overview.",
      },
    ]);
  });

  test("batches selected URLs through Fetch and falls back to snippets on partial results", async () => {
    let requestNumber = 0;
    const fetchFn: FetchLike = async (input, init) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        expect(String(input).startsWith("https://api.search.tinyfish.ai?")).toBeTrue();
        return Response.json({
          query: "contextual integration",
          results: [
            {
              position: 1,
              site_name: "Example",
              title: "General explanation",
              snippet: "Search snippet fallback.",
              url: "https://example.com/context",
            },
            {
              position: 2,
              site_name: "arXiv",
              title: "Contextual integration study",
              snippet: "Preprint snippet.",
              url: "https://arxiv.org/abs/1234.5678",
            },
          ],
          total_results: 2,
          page: 0,
        });
      }

      expect(String(input)).toBe("https://api.fetch.tinyfish.ai");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("tinyfish-key");
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toEqual({
        urls: [
          "https://arxiv.org/abs/1234.5678",
          "https://example.com/context",
        ],
        format: "markdown",
        per_url_timeout_ms: 45_000,
      });
      return Response.json({
        results: [
          {
            url: "https://arxiv.org/abs/1234.5678",
            final_url: "https://arxiv.org/abs/1234.5678",
            title: "Fetched contextual integration study",
            language: "en",
            format: "markdown",
            text: "# Full extracted paper content",
          },
        ],
        errors: [
          {
            url: "https://example.com/context",
            error: "bot_blocked",
          },
        ],
      });
    };

    const results = await searchAndFetchWebWithTinyFish(
      "contextual integration",
      settings,
      2,
      undefined,
      fetchFn,
    );

    expect(requestNumber).toBe(2);
    expect(results).toEqual([
      {
        title: "Fetched contextual integration study",
        url: "https://arxiv.org/abs/1234.5678",
        content: "# Full extracted paper content",
      },
      {
        title: "General explanation",
        url: "https://example.com/context",
        content: "Search snippet fallback.",
      },
    ]);
  });

  test("does not call TinyFish when automatic search is disabled", async () => {
    const disabledSettings = { ...settings, webSearchEnabled: false } satisfies AppSettings;
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return Response.json({ results: [] });
    };

    await expect(
      searchWebWithTinyFish("test", disabledSettings, 5, undefined, fetchFn),
    ).resolves.toEqual([]);
    expect(called).toBeFalse();
  });

  test("keeps Search snippets when the Fetch request fails", async () => {
    let requestNumber = 0;
    const fetchFn: FetchLike = async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return Response.json({
          query: "source",
          results: [
            {
              position: 1,
              site_name: "Example",
              title: "Search result",
              snippet: "Usable snippet.",
              url: "https://example.com/source",
            },
          ],
          total_results: 1,
          page: 0,
        });
      }
      return Response.json(
        { error: { code: "SERVICE_BUSY", message: "Try again later." } },
        { status: 503 },
      );
    };

    await expect(
      searchAndFetchWebWithTinyFish("source", settings, 1, undefined, fetchFn),
    ).resolves.toEqual([
      {
        title: "Search result",
        url: "https://example.com/source",
        content: "Usable snippet.",
      },
    ]);
  });
});

import type { AppSettings } from "../../shared/rpc-types";

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export async function searchWebWithOllama(
  query: string,
  settings: AppSettings,
  maxResults = 5,
): Promise<WebSearchResult[]> {
  const apiKey = settings.ollamaApiKey.trim();
  if (!settings.ollamaWebSearchEnabled || !apiKey) return [];

  const res = await fetch("https://ollama.com/api/web_search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.max(1, Math.min(10, maxResults)),
    }),
  });

  if (!res.ok) throw new Error(`Ollama web search error: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json() as { results?: WebSearchResult[] };
  return (json.results ?? []).filter((result) => result.title && result.url);
}

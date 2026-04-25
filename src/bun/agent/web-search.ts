import type { AppSettings } from "../../shared/rpc-types";

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

interface OllamaWebSearchResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
}

interface OllamaWebFetchResult {
  title?: string;
  content?: string;
  links?: string[];
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
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
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      query,
      max_results: Math.max(1, Math.min(10, maxResults)),
    }),
  });

  if (!res.ok) throw new Error(`Ollama web search error: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json() as { results?: OllamaWebSearchResult[] };
  return (json.results ?? [])
    .filter((result): result is OllamaWebSearchResult & { title: string; url: string } =>
      Boolean(result.title && result.url)
    )
    .map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content ?? result.snippet ?? "",
    }));
}

export async function fetchWebPageWithOllama(
  url: string,
  settings: AppSettings,
): Promise<WebSearchResult | null> {
  const apiKey = settings.ollamaApiKey.trim();
  if (!settings.ollamaWebSearchEnabled || !apiKey) return null;

  const res = await fetch("https://ollama.com/api/web_fetch", {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ url }),
  });

  if (!res.ok) throw new Error(`Ollama web fetch error: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json() as OllamaWebFetchResult;
  if (!json.content) return null;
  return {
    title: json.title || url,
    url,
    content: json.content,
  };
}

export async function searchAndFetchWebWithOllama(
  query: string,
  settings: AppSettings,
  maxResults = 5,
): Promise<WebSearchResult[]> {
  const searchResults = await searchWebWithOllama(query, settings, maxResults);
  if (searchResults.length === 0) return [];

  const fetched = await Promise.all(
    searchResults.map(async (result) => {
      try {
        return await fetchWebPageWithOllama(result.url, settings);
      } catch (err) {
        console.warn(`[Agent] Web fetch failed for ${result.url}:`, err);
        return null;
      }
    }),
  );

  return searchResults.map((result, index) => fetched[index] ?? result);
}

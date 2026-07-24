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

const ACADEMIC_HOST_MARKERS = [
  "doi.org",
  "openalex.org",
  "crossref.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "arxiv.org",
  "semanticscholar.org",
  "jstor.org",
  "projectmuse.jhu.edu",
  "acm.org",
  "ieee.org",
  "springer.com",
  "sciencedirect.com",
  "wiley.com",
  "tandfonline.com",
  "sagepub.com",
  "nature.com",
  "science.org",
  "oup.com",
  "cambridge.org",
  "plos.org",
  "frontiersin.org",
  "bmj.com",
  "mdpi.com",
];

export function academicSourceScore(result: WebSearchResult): number {
  let score = 0;
  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    if (ACADEMIC_HOST_MARKERS.some((marker) => hostname === marker || hostname.endsWith(`.${marker}`))) {
      score += 100;
    }
    if (hostname.endsWith(".edu") || hostname.endsWith(".ac.uk")) score += 45;
    if (hostname.endsWith(".kr")) score -= 20;
  } catch {
    score -= 10;
  }

  const searchable = `${result.title} ${result.content}`;
  if (/\b(?:doi|journal|abstract|peer-reviewed|systematic review|meta-analysis|research article)\b/i.test(searchable)) {
    score += 20;
  }
  if (/[\u3131-\u318E\uAC00-\uD7A3]/u.test(result.title)) score -= 15;
  return score;
}

export function prioritizeAcademicResults(results: WebSearchResult[]): WebSearchResult[] {
  return results
    .map((result, index) => ({ result, index, score: academicSourceScore(result) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => result);
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
  signal?: AbortSignal,
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
    signal,
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
  signal?: AbortSignal,
): Promise<WebSearchResult | null> {
  const apiKey = settings.ollamaApiKey.trim();
  if (!settings.ollamaWebSearchEnabled || !apiKey) return null;

  const res = await fetch("https://ollama.com/api/web_fetch", {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ url }),
    signal,
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
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const searchResults = prioritizeAcademicResults(
    await searchWebWithOllama(
      query,
      settings,
      Math.min(10, Math.max(maxResults, maxResults * 2)),
      signal,
    ),
  ).slice(0, maxResults);
  if (searchResults.length === 0) return [];

  const fetched = await Promise.all(
    searchResults.map(async (result) => {
      try {
        return await fetchWebPageWithOllama(result.url, settings, signal);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        console.warn(`[Agent] Web fetch failed for ${result.url}:`, err);
        return null;
      }
    }),
  );

  return searchResults.map((result, index) => fetched[index] ?? result);
}

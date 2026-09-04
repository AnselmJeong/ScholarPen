import type { AgentStreamParams, AppSettings, LLMProvider, OllamaMessage } from "../../shared/rpc-types";
import { completeAgentModel } from "./providers";

const DECISION_PROMPT = `Decide whether the assistant should use live web search before answering.

Return exactly one token:
SEARCH
NO_SEARCH

Use SEARCH when the request needs or would materially benefit from external evidence: current or time-sensitive facts; factual verification; academic literature or evidence; source recommendations; unfamiliar or niche claims; laws, policies, prices, releases, schedules, public figures, companies, or products; or whenever the user explicitly asks to search, browse, look up, find, or verify something online.
Use NO_SEARCH for pure rewriting, editing, translation, summarization of supplied text, brainstorming, creative work, project-local questions, and requests fully answerable from provided files or conversation context.

When uncertain whether external evidence would improve factual accuracy, choose SEARCH.`;

export function parseWebSearchDecision(text: string): boolean {
  return text.trim().toUpperCase().startsWith("SEARCH");
}

export function explicitlyRequestsWebSearch(message: string): boolean {
  return /(?:\b(?:search|browse|look\s*up|find\s+(?:me\s+)?sources?|verify\s+online|check\s+online)\b|(?:인터넷|웹|온라인).{0,12}(?:검색|찾아|확인)|(?:검색|찾아봐|찾아\s*줘|조사해\s*줘))/iu.test(message);
}

function decisionMessages(params: AgentStreamParams): OllamaMessage[] {
  const history = params.history
    .slice(-4)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const selectedFiles = params.selectedFilePaths.length > 0
    ? `\n\nSelected local files are present: ${params.selectedFilePaths.join(", ")}`
    : "";
  return [
    { role: "system", content: DECISION_PROMPT },
    {
      role: "user",
      content: `${history ? `Recent conversation:\n${history}\n\n` : ""}User request:\n${params.message}${selectedFiles}`,
    },
  ];
}

export async function shouldUseWebSearch(
  params: AgentStreamParams,
  settings: AppSettings,
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (explicitlyRequestsWebSearch(params.message)) return true;
  const messages = decisionMessages(params);
  const result = await completeAgentModel({
    provider,
    model,
    messages,
    // Leave enough room for reasoning models to reach the final SEARCH token.
    maxTokens: 256,
    temperature: 0,
    signal,
  }, settings);
  return parseWebSearchDecision(result);
}

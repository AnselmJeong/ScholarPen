import type { AgentStreamParams, AppSettings, LLMProvider, OllamaMessage } from "../../shared/rpc-types";
import { completeAgentModel } from "./providers";

const DECISION_PROMPT = `Decide whether the assistant must use live web search before answering.

Return exactly one token:
SEARCH
NO_SEARCH

Use SEARCH only when the user asks for current, recent, latest, breaking, web-only, price, release, schedule, version, law/policy, public figure, company, product, or otherwise time-sensitive facts.
Use NO_SEARCH for rewriting, editing, brainstorming, stable general knowledge, project-local questions, and requests that can be answered from provided files or conversation context.

Knowledge Base is OFF for this decision.`;

function parseDecision(text: string): boolean {
  return text.trim().toUpperCase().startsWith("SEARCH");
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
  return parseDecision(result);
}

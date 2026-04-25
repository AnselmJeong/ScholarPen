import type { AgentStreamParams, AppSettings, LLMProvider, OllamaMessage } from "../../shared/rpc-types";

const DECISION_PROMPT = `Decide whether the assistant must use live web search before answering.

Return exactly one token:
SEARCH
NO_SEARCH

Use SEARCH only when the user asks for current, recent, latest, breaking, web-only, price, release, schedule, version, law/policy, public figure, company, product, or otherwise time-sensitive facts.
Use NO_SEARCH for rewriting, editing, brainstorming, stable general knowledge, project-local questions, and requests that can be answered from provided files or conversation context.

Knowledge Base is OFF for this decision.`;

function ensureApiKey(provider: string, apiKey: string): string {
  if (!apiKey.trim()) throw new Error(`${provider} API key is not configured in Settings.`);
  return apiKey.trim();
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item && "text" in item && typeof item.text === "string") return item.text;
      return "";
    })
    .join("");
}

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

  if (provider === "ollama") {
    const baseUrl = (settings.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || settings.ollamaDefaultModel,
        messages,
        stream: false,
        think: false,
        options: { temperature: 0 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama web-search decision error: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    return parseDecision(json.message?.content ?? json.response ?? "");
  }

  if (provider === "anthropic") {
    const apiKey = ensureApiKey("Claude", settings.anthropicApiKey);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || settings.anthropicDefaultModel,
        max_tokens: 8,
        temperature: 0,
        system: messages[0].content,
        messages: [{ role: "user", content: messages[1].content }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Claude web-search decision error: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    return parseDecision(firstText(json.content));
  }

  const isDeepSeek = provider === "deepseek";
  const apiKey = ensureApiKey(isDeepSeek ? "DeepSeek" : "OpenAI", isDeepSeek ? settings.deepseekApiKey : settings.openaiApiKey);
  const baseUrl = (isDeepSeek ? settings.deepseekBaseUrl : settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || (isDeepSeek ? settings.deepseekDefaultModel : settings.openaiDefaultModel),
      messages,
      temperature: 0,
      max_tokens: 8,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`${isDeepSeek ? "DeepSeek" : "OpenAI"} web-search decision error: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  return parseDecision(json.choices?.[0]?.message?.content ?? "");
}

import type { OllamaMessage } from "../../shared/rpc-types";
import { detectStyleLanguage, type StyleContext, type StyleRequest } from "../../shared/author-style";
import { authorStyle } from "../extensions/author-style";
import { writingPreferences } from "./writing-preferences";
import { punctuationGuidance, parsePunctuationPolicy, punctuationFromPrompt } from "../../shared/writing-preferences";

/** Conservative purpose adapter for the historical free-form chat API. */
export function legacyWritingPurpose(message: string): StyleRequest["purpose"] {
  if (/번역|\btranslate\b/i.test(message)) return "translate";
  if (/고쳐|고치|교정|다듬|재작성|윤문|\b(?:rewrite|rephrase|proofread|revise)\b/i.test(message)) return "rewrite";
  if (/작성해|써\s*줘|초안|\b(?:draft|compose|write)\b/i.test(message)) return "draft";
  return "chat";
}

/** Single provider-independent entry point. Analysis callers use an explicit non-writing purpose. */
export async function styleContext(projectPath: string | undefined, request: StyleRequest): Promise<StyleContext> {
  const context = await authorStyle.context(projectPath, request).catch(error => ({ text: "", reason: String(error) }));
  if (["style-learn", "extract", "review-evaluate"].includes(request.purpose)) return context;
  const punctuation = request.punctuation ? parsePunctuationPolicy(request.punctuation) : await writingPreferences.policyForRequest();
  return { ...context, text: [punctuationGuidance(punctuation), context.text].filter(Boolean).join("\n\n") };
}
export async function composeWritingContext(messages: OllamaMessage[], projectPath: string | undefined, request: StyleRequest): Promise<OllamaMessage[]> {
  if (messages.some(m => m.role === "system" && (m.content.includes("<scholarpen_style ") || m.content.includes("<scholarpen_writing_context>")))) return messages;
  const captured = messages.filter(m => m.role === "system").map(m => punctuationFromPrompt(m.content)).find(Boolean);
  const context = await styleContext(projectPath, { ...request, punctuation: captured ?? request.punctuation, language: request.language ?? detectStyleLanguage(messages.filter(m => m.role === "user").at(-1)?.content ?? "") });
  const text = captured ? context.text.replace(/<scholarpen_punctuation\b[^>]*>[\s\S]*?<\/scholarpen_punctuation>\s*/, "") : context.text;
  return context.text ? [{ role: "system", content: `<scholarpen_writing_context>\n${text}\n</scholarpen_writing_context>` }, ...messages] : messages;
}

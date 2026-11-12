import type { OllamaMessage } from "./rpc-types";

export interface PunctuationPolicy { emDash: "avoid" | "allow"; semicolon: "avoid" | "allow" }
export interface WritingPreferences { version: 1; revision: number; punctuation: PunctuationPolicy }
export const DEFAULT_PUNCTUATION: Readonly<PunctuationPolicy> = { emDash: "avoid", semicolon: "avoid" };
export const PUNCTUATION_PLACEHOLDER = "<scholarpen_punctuation_policy/>";
export const PROSE_PROTECTION = "Preserve exact source quotations, bibliographic titles, protected control markers, code, math, URLs and required literal text. Keep compound-word hyphens, numerical-range en dashes, and punctuation inside citations and reference lists. Never alter a protected control marker or protected literal to enforce a preference. Never alter scientific meaning, numbers, citations or uncertainty to enforce style.";

export function parsePunctuationPolicy(value: unknown): PunctuationPolicy {
  if (!value || typeof value !== "object" || !("emDash" in value) || !("semicolon" in value) ||
      !["avoid", "allow"].includes(String(value.emDash)) || !["avoid", "allow"].includes(String(value.semicolon)) ||
      Object.keys(value).some(key => key !== "emDash" && key !== "semicolon")) throw new Error("잘못된 문장부호 정책입니다.");
  return { emDash: value.emDash as PunctuationPolicy["emDash"], semicolon: value.semicolon as PunctuationPolicy["semicolon"] };
}
export function punctuationGuidance(policy: PunctuationPolicy): string {
  return `<scholarpen_punctuation emDash="${policy.emDash}" semicolon="${policy.semicolon}">\n` +
    "Explicit author punctuation preferences for newly written or rewritten prose. The current user's explicit instructions take precedence. These punctuation settings override conflicting profile rules and examples. " +
    (policy.emDash === "avoid" ? "Avoid em dashes (U+2014) and rhetorical en dashes or double hyphens. Recast them with commas, parentheses, colons or separate sentences. " : "Em dashes are allowed when appropriate. Do not remove them solely because of a style default. ") +
    (policy.semicolon === "avoid" ? "Avoid semicolons joining prose clauses. Use separate sentences or a conjunction, never a comma splice. " : "Semicolons are allowed when appropriate. Do not remove them solely because of a style default. ") +
    PROSE_PROTECTION + "\n</scholarpen_punctuation>";
}
export function punctuationFromPrompt(text: string): PunctuationPolicy | undefined {
  const match = text.match(/<scholarpen_punctuation emDash="(avoid|allow)" semicolon="(avoid|allow)">/);
  return match ? parsePunctuationPolicy({ emDash: match[1], semicolon: match[2] }) : undefined;
}
/** Preserve the request's captured policy, replace every historical placeholder, inject at most once. */
export function applyPunctuationPolicy(messages: OllamaMessage[], fallback: PunctuationPolicy): OllamaMessage[] {
  const existing = messages.filter(m => m.role === "system").map(m => punctuationFromPrompt(m.content)).find(Boolean);
  const hasPlaceholder = messages.some(m => m.role === "system" && m.content.includes(PUNCTUATION_PLACEHOLDER));
  if (!hasPlaceholder) return messages;
  let injected = !!existing;
  return messages.map(m => {
    if (m.role !== "system") return m;
    return { ...m, content: m.content.replaceAll(PUNCTUATION_PLACEHOLDER, () => {
      if (injected) return ""; injected = true; return punctuationGuidance(fallback);
    }) };
  });
}

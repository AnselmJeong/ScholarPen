/**
 * ScholarPen AI, the one AI collaborator in a document: its own comment
 * author, collaboration cursor, @ai handle and review focus.
 */
export interface Persona {
  id: string;
  /** User id on the comments it writes. */
  userId: string;
  /** Mention handle, without "@" (case-insensitive). */
  handle: string;
  name: string;
  shortName: string;
  color: string;
  /** What it looks for when reviewing a section. */
  reviewFocus: string;
  /** Review categories it reports. */
  categories: string[];
}

export const DEFAULT_PERSONA_ID = "scholarpen-ai";

export const SCHOLARPEN_AI: Persona = {
  id: DEFAULT_PERSONA_ID,
  userId: "scholarpen-ai",
  handle: "ai",
  name: "ScholarPen AI",
  shortName: "AI",
  color: "#7c3aed",
  reviewFocus:
    "claims stated more strongly than the evidence or citations allow, claims that need a citation but have none, " +
    "citations that seem not to support the sentence, logical gaps or non sequiturs, contradictions with the rest of the manuscript, " +
    "undefined key terms; statistical reporting and inference (missing effect sizes or confidence intervals, p-values read as effect size, " +
    "uncorrected multiple comparisons, causal language from correlational designs, inappropriate tests, numbers inconsistent with each other); " +
    "and what a skeptical journal referee would object to (unclear novelty, alternative explanations not addressed, missing limitations, " +
    "generalisations beyond the sample, missing key literature)",
  categories: [
    "overclaim", "missing-citation", "citation", "logic", "consistency", "definition",
    "statistics", "inference", "reporting",
    "novelty", "alternative-explanation", "limitation", "generalisation", "literature",
  ],
};

/**
 * Earlier versions split the AI into a statistics reviewer and "Reviewer 2".
 * Their comments in existing documents still count as the AI's, and their
 * handles still address it.
 */
const LEGACY_USER_IDS = new Set(["scholarpen-stats", "scholarpen-reviewer2"]);
const LEGACY_HANDLES = new Set(["stats", "reviewer2"]);

export function personaByUser(userId: string | undefined | null): Persona | null {
  if (!userId) return null;
  return userId === SCHOLARPEN_AI.userId || LEGACY_USER_IDS.has(userId) ? SCHOLARPEN_AI : null;
}

export function isAIUser(userId: string | undefined | null) {
  return personaByUser(userId) !== null;
}

/** ScholarPen AI when the text addresses it with @ai, otherwise null. */
export function mentionedPersona(text: string): Persona | null {
  for (const match of text.matchAll(/(^|\s)@([a-z0-9_-]+)\b/gi)) {
    const handle = match[2].toLowerCase();
    if (handle === SCHOLARPEN_AI.handle || LEGACY_HANDLES.has(handle)) return SCHOLARPEN_AI;
  }
  return null;
}

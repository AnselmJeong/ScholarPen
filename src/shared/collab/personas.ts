/**
 * AI personas. Each is a separate peer in the document: its own comment
 * author, collaboration cursor, @handle and review focus.
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
  /** What this persona looks for when reviewing a section. */
  reviewFocus: string;
  /** Extra guidance when it answers a thread with an edit. */
  editGuidance?: string;
  /** Review categories this persona reports. */
  categories: string[];
}

export const DEFAULT_PERSONA_ID = "scholarpen-ai";

export const PERSONAS: Persona[] = [
  {
    id: DEFAULT_PERSONA_ID,
    userId: "scholarpen-ai",
    handle: "ai",
    name: "ScholarPen AI",
    shortName: "AI",
    color: "#7c3aed",
    reviewFocus:
      "claims stated more strongly than the evidence or citations allow, claims that need a citation but have none, " +
      "citations that seem not to support the sentence, logical gaps or non sequiturs, contradictions with the rest of the manuscript, " +
      "and undefined key terms",
    categories: ["overclaim", "missing-citation", "citation", "logic", "consistency", "definition"],
  },
  {
    id: "stats-reviewer",
    userId: "scholarpen-stats",
    handle: "stats",
    name: "Statistics reviewer",
    shortName: "Stats",
    color: "#0d9488",
    reviewFocus:
      "statistical reporting and inference: missing effect sizes or confidence intervals, p-values interpreted as effect size, " +
      "multiple comparisons without correction, underpowered or unjustified sample sizes, causal language from correlational designs, " +
      "inappropriate tests for the data, and numbers that are inconsistent with each other",
    editGuidance: "Act as a biostatistician: make statistical reporting precise and its conclusions proportionate to the analysis.",
    categories: ["statistics", "inference", "reporting", "consistency"],
  },
  {
    id: "reviewer-2",
    userId: "scholarpen-reviewer2",
    handle: "reviewer2",
    name: "Reviewer 2",
    shortName: "R2",
    color: "#b45309",
    reviewFocus:
      "what a skeptical journal referee would object to: unclear novelty or contribution, alternative explanations not addressed, " +
      "missing limitations, generalisations beyond the sample, weak links between the evidence and the conclusion, and missing key literature",
    editGuidance: "Act as a demanding but fair journal referee: address the objection so the passage would survive peer review.",
    categories: ["novelty", "alternative-explanation", "limitation", "generalisation", "literature", "logic"],
  },
];

export function personaById(id: string | undefined | null): Persona {
  return PERSONAS.find((persona) => persona.id === id) ?? PERSONAS[0];
}

export function personaByUser(userId: string | undefined | null): Persona | null {
  return PERSONAS.find((persona) => persona.userId === userId) ?? null;
}

export function isAIUser(userId: string | undefined | null) {
  return personaByUser(userId) !== null;
}

/** The persona a comment addresses with @handle, if any (the last mention wins). */
export function mentionedPersona(text: string): Persona | null {
  let found: Persona | null = null;
  for (const match of text.matchAll(/(^|\s)@([a-z0-9_-]+)\b/gi)) {
    const persona = PERSONAS.find((candidate) => candidate.handle === match[2].toLowerCase());
    if (persona) found = persona;
  }
  return found;
}

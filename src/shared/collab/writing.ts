import type * as Y from "yjs";

/** Per-document writing preferences shared by the author and the AI (in the Y.Doc). */
export const WRITING_MAP = "writing";

/** How far ScholarPen AI may change the author's text. */
export type EditLevel = "proofread" | "sentence" | "structural";

export const EDIT_LEVELS: ReadonlyArray<{ id: EditLevel; label: string; description: string }> = [
  { id: "proofread", label: "Proofread", description: "Spelling, grammar, punctuation and wording errors only. Meaning, claims and citations stay as they are." },
  { id: "sentence", label: "Sentence", description: "Sentences may be rewritten, split, merged, added or removed inside a paragraph; each paragraph keeps its role and claims." },
  { id: "structural", label: "Structural", description: "Paragraphs may be substantially rewritten and claims added, removed or reordered when a comment calls for it." },
];

export const DEFAULT_EDIT_LEVEL: EditLevel = "sentence";

/**
 * Largest share of a paragraph one AI edit may change at each level; larger
 * rewrites are discarded and reported instead of applied.
 */
export const EDIT_LEVEL_MAX_CHANGE: Record<EditLevel, number> = { proofread: 0.25, sentence: 0.6, structural: 1 };

export function isEditLevel(value: unknown): value is EditLevel {
  return value === "proofread" || value === "sentence" || value === "structural";
}

export function editLevelOf(map: Y.Map<unknown>): EditLevel {
  const level = map.get("editLevel");
  return isEditLevel(level) ? level : DEFAULT_EDIT_LEVEL;
}

export function setEditLevel(map: Y.Map<unknown>, level: EditLevel) {
  map.set("editLevel", level);
}

export function editLevelLabel(level: EditLevel) {
  return EDIT_LEVELS.find(item => item.id === level)!.label;
}

/** The scope rule every AI edit prompt carries. */
export function editLevelGuidance(level: EditLevel) {
  switch (level) {
    case "proofread":
      return "EDIT LEVEL: PROOFREAD. The author allows corrections only: spelling, grammar, punctuation, agreement, wrong or unclear words, and terminology required by the glossary. " +
        "Do not change meaning, claims, hedging, sentence order or paragraph structure, and do not add sentences or citations. " +
        "If a request needs more than a correction, make no edit for it and say so (or mark it needs-user) so the author can raise the level.";
    case "sentence":
      return "EDIT LEVEL: SENTENCE. You may rewrite, split, merge, add or remove sentences inside a paragraph to fix clarity, precision, flow and calibration, " +
        "but each paragraph keeps its role and its claims. Do not restructure the argument across paragraphs or rewrite most of a paragraph; " +
        "describe such a reorganization in your reply instead.";
    case "structural":
      return "EDIT LEVEL: STRUCTURAL. You may substantially rewrite paragraphs, reorder their reasoning, and add, remove or reframe claims when the request calls for it. " +
        "Edits still cannot move text between paragraphs; propose larger reorganizations across sections in your reply.";
  }
}

export function editLevelExceeded(level: EditLevel, rate: number) {
  return rate > EDIT_LEVEL_MAX_CHANGE[level];
}

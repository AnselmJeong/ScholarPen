import type * as Y from "yjs";

/** Per-document reviewer state and preferences, stored in the shared Y.Doc. */
export const REVIEW_MAP = "review";

export type ReviewSeverity = "low" | "medium" | "high";
export const SEVERITY_RANK: Record<ReviewSeverity, number> = { low: 0, medium: 1, high: 2 };

export interface ReviewFinding {
  /** Index of the paragraph in the reviewed section, or -1 for deterministic checks. */
  paragraph: number;
  quote: string;
  category: string;
  severity: ReviewSeverity;
  comment: string;
}

export interface ReviewSettings {
  /** Review sections automatically once the author leaves them. */
  autoReview: boolean;
  /** Findings below this severity are not posted. */
  minSeverity: ReviewSeverity;
  /** Finding categories the author asked the AI to stop raising. */
  muted: string[];
}

export const REVIEW_CATEGORY_LABEL: Record<string, string> = {
  overclaim: "Overclaim",
  "missing-citation": "Needs citation",
  citation: "Citation",
  logic: "Logic",
  consistency: "Consistency",
  definition: "Definition",
};

export function reviewSettingsOf(map: Y.Map<any>): ReviewSettings {
  return {
    autoReview: map.get("autoReview") ?? true,
    minSeverity: map.get("minSeverity") ?? "medium",
    muted: map.get("muted") ?? [],
  };
}

export function updateReviewSettings(map: Y.Map<any>, patch: Partial<ReviewSettings>) {
  for (const [key, value] of Object.entries(patch)) map.set(key, value);
}

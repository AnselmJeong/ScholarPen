import type * as Y from "yjs";

/** Per-document reviewer state and preferences, stored in the shared Y.Doc. */
export const REVIEW_MAP = "review";

export type ReviewSeverity = "low" | "medium" | "high";
export const SEVERITY_RANK: Record<ReviewSeverity, number> = { low: 0, medium: 1, high: 2 };

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return value === "low" || value === "medium" || value === "high";
}

export interface ReviewFinding {
  /** Index of the paragraph in the reviewed section, or -1 for deterministic checks. */
  paragraph: number;
  quote: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  comment: string;
}

export interface ReviewProgress {
  reviewedSections: number;
  totalSections: number;
}

export interface ReviewSettings {
  /** Review the whole open document, independently of author edits. */
  autoReview: boolean;
  /** Findings below this severity are not posted. */
  minSeverity: ReviewSeverity;
  /** Finding categories the author asked the AI to stop raising. */
  muted: ReviewCategory[];
}

/** The complete, closed vocabulary for automatic review comments. */
export const REVIEW_CATEGORIES = [
  { id: "logic", label: "Logic", description: "Gaps in reasoning or conclusions that do not follow." },
  { id: "citation", label: "Citation", description: "Missing sources, invalid reference keys, or sources that do not support a claim." },
  { id: "overclaim", label: "Overclaim", description: "Claims stated more strongly than the evidence permits." },
  { id: "consistency", label: "Consistency", description: "Contradictions within the manuscript." },
  { id: "definition", label: "Definition", description: "Key terms that need a clear definition." },
  { id: "statistics", label: "Statistics", description: "Statistical methods, effect sizes, uncertainty, and numerical errors." },
  { id: "inference", label: "Inference", description: "Causal or other inferences the study design cannot support." },
  { id: "reporting", label: "Reporting", description: "Missing methodological details needed to assess the work." },
  { id: "novelty", label: "Novelty", description: "An unclear contribution relative to prior work." },
  { id: "alternative-explanation", label: "Alternative explanation", description: "Plausible competing explanations not considered." },
  { id: "limitation", label: "Limitation", description: "Limitations or caveats that need discussion." },
  { id: "generalisation", label: "Generalisation", description: "Extrapolation beyond the studied sample or setting." },
  { id: "literature", label: "Literature", description: "Important related work or perspectives missing from the discussion." },
] as const;

export type ReviewCategory = typeof REVIEW_CATEGORIES[number]["id"];
export interface ProjectReviewSettings {
  disabledCategories: ReviewCategory[];
}
export const PROJECT_REVIEW_SETTINGS_KEY = "projectCategories";

/** Old labels and model spelling variants map to one canonical category. Unknown types are rejected. */
export function normalizeReviewCategory(value: unknown): ReviewCategory | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const aliases: Record<string, ReviewCategory> = {
    "missing-citation": "citation", "needs-citation": "citation", "need-citation": "citation",
    "citation-needed": "citation", generalization: "generalisation", limitations: "limitation",
    "alternative-explanations": "alternative-explanation",
  };
  return REVIEW_CATEGORIES.find(category => category.id === key)?.id ?? aliases[key] ?? null;
}

export function normalizeReviewCategories(values: unknown): ReviewCategory[] {
  const selected = new Set(Array.isArray(values) ? values.map(normalizeReviewCategory) : []);
  return REVIEW_CATEGORIES.filter(category => selected.has(category.id)).map(category => category.id);
}

export function reviewCategoryLabel(value: unknown): string {
  if (value === "draft") return "Draft"; // A drafting workflow marker, not a review category.
  const id = normalizeReviewCategory(value);
  return REVIEW_CATEGORIES.find(category => category.id === id)?.label ?? "Review";
}

/** A review finding whose type the project turned off. Comments without a review type never are. */
export function isDisabledReviewType(category: unknown, disabled: readonly ReviewCategory[]) {
  const id = normalizeReviewCategory(category);
  return id !== null && disabled.includes(id);
}

export function enabledReviewCategories(settings: ReviewSettings): ReviewCategory[] {
  return REVIEW_CATEGORIES.filter(category => !settings.muted.includes(category.id)).map(category => category.id);
}

export function reviewSettingsOf(map: Y.Map<unknown>): ReviewSettings {
  const project = map.get(PROJECT_REVIEW_SETTINGS_KEY) as ProjectReviewSettings | undefined;
  const severity = map.get("minSeverity");
  return {
    autoReview: map.get("autoReview") !== false,
    minSeverity: isReviewSeverity(severity) ? severity : "high",
    // Once connected to a project, one project policy replaces old document-only mutes.
    muted: normalizeReviewCategories(project ? project.disabledCategories : map.get("muted")),
  };
}

export function updateReviewSettings(map: Y.Map<any>, patch: Partial<ReviewSettings>) {
  for (const [key, value] of Object.entries(patch)) map.set(key, value);
}

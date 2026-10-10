import type { ProjectJobStatus } from "./manuscript-map";

/** One cross-document problem found by the project consistency check. */
export interface ConsistencyIssue {
  id: string;
  kind: "broken-reference" | "duplicate" | "contradiction" | "terminology";
  /** Document the issue is in, relative to `documents/`. */
  filename: string;
  blockId?: string;
  /** Exact words in that document. */
  quote: string;
  comment: string;
  /** The other place involved (the duplicated or contradicting passage). */
  related?: { filename: string; quote: string };
}

export interface ConsistencyReport {
  createdAt: number;
  documents: number;
  issues: ConsistencyIssue[];
  /** Comments posted into documents that were open when the check ran. */
  posted: number;
  /** Parts of the check that could not run, e.g. the contradiction pass without a model. */
  skipped: string[];
}

export interface ConsistencyView { report: ConsistencyReport | null; job: ProjectJobStatus }

export const CONSISTENCY_KIND_LABEL: Record<ConsistencyIssue["kind"], string> = {
  "broken-reference": "Broken reference",
  duplicate: "Duplicated text",
  contradiction: "Contradiction",
  terminology: "Terminology",
};

const KINDS = new Set(Object.keys(CONSISTENCY_KIND_LABEL));

export function normalizeConsistencyReport(value: unknown): ConsistencyReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ConsistencyReport>;
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((issue): issue is ConsistencyIssue => !!issue && typeof issue === "object" &&
    KINDS.has(issue.kind) && typeof issue.filename === "string" && typeof issue.comment === "string" && typeof issue.quote === "string") : [];
  return {
    createdAt: Number(raw.createdAt) || 0,
    documents: Number(raw.documents) || 0,
    issues: issues.map((issue, index) => ({ ...issue, id: typeof issue.id === "string" ? issue.id : `issue-${index}` })),
    posted: Number(raw.posted) || 0,
    skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((item): item is string => typeof item === "string") : [],
  };
}

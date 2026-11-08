export type ReviewMode = "virtual" | "peer";
export type ReviewStatus = "created" | "running" | "paused" | "cancelled" | "failed" | "completed";
export type ReviewQuality = "not-assessed" | "ready-for-author-review" | "needs-author-action" | "incomplete-coverage";
export interface ReviewerProfile { id: string; name: string; focus: string; original: string }
export interface ReviewInput {
  projectPath: string; documents: string[]; mode: ReviewMode; maxCycles: 1 | 2;
  reviewerModel: string; reviserModel: string; reviewers: ReviewerProfile[];
  decisionLetter: string; language: string; authorConstraints: string; baselineNote: string;
  parentSessionId?: string;
}
export interface ReviewComment { parentId?: string; sourceStart?: number; sourceEnd?: number; id: string; reviewerId: string; original: string; targets: string[]; severity: "major" | "minor"; source: "human" | "virtual" }
export type Disposition = "changed" | "clarified-no-change" | "reasoned-disagreement" | "partially-addressed" | "needs-author" | "awaiting-figure-approval" | "unresolved";
export interface ResponseItem { commentId: string; disposition: Disposition; response: string; changeIds: string[]; locations: string[]; verification: "verified" | "not-verified" | "regressed" | "not-assessed" }
export interface TextSlot { id: string; document: string; blockId: string; path: (string | number)[]; text: string; kind: "text" | "table" | "caption" }
export interface Calculation { operation: "sum" | "percent"; sourceSlotIds: string[]; decimals: number }
export interface TextPatch { kind: "set-text"; id: string; slotId: string; before: string; after: string; commentIds: string[]; rationale: string; calculation?: Calculation }
export interface RowPatch { kind: "reorder-rows"; id: string; document: string; blockId: string; beforeHash: string; order: number[]; commentIds: string[]; rationale: string }
export type PatchOperation = TextPatch | RowPatch;
export interface AuthorCheck { kind?: "text" | "figure" | "review" | "response"; id: string; target: string; before: string; proposed: string; commentIds: string[]; rationale: string; reason: string }
export interface AppliedChange { id: string; target: string; before: string; after: string; commentIds: string[]; rationale: string }
export interface FigureProposal { figureId: string; specification: string; commentIds: string[] }
export interface RevisionPlan { principles: string[]; argumentMap: string; conflicts: string[]; patches: PatchOperation[]; figures: FigureProposal[]; decisions: { commentId: string; disposition: Disposition; reason: string }[] }
export interface FigureApproval extends FigureProposal { id: string; round: number; inputHash: string; specificationHash: string; method: "import-replacement"; status: "pending" | "approved" | "kept" | "deferred" | "imported"; outputPath?: string; outputHash?: string; failureReason?: string }
export interface ReviewFigure { id: string; document: string; blockId: string; path: (string | number)[]; source: string; caption: string; hash: string; available: boolean; reason?: string }
export interface CoverageItem { target: string; hash: string; status: "read" | "unavailable"; detail: string }
export interface Assessment { needsRevision: boolean; regression: boolean; summary: string; issues: string[]; comments: { commentId: string; verification: ResponseItem["verification"]; reason: string }[] }
export interface RoundResult { authorChecks?: AuthorCheck[]; round: number; packageHash: string; plan: RevisionPlan; changes: AppliedChange[]; responses: ResponseItem[]; assessment: Assessment; coverage: CoverageItem[]; validation: string[] }
export interface ManifestFile { path: string; hash: string; bytes: number }
export interface ReviewManifest { schemaVersion: 1; files: ManifestFile[]; packageHash: string; warnings: string[] }
export interface ReviewSession {
  editablePath?: string;
  warnings?: { stage: string; reason: string }[];
  schemaVersion: 1; id: string; createdAt: string; updatedAt: string; input: ReviewInput;
  roles: { reviewer: { provider: "codex"; model: string }; reviser: { provider: "anthropic"; model: string } };
  status: ReviewStatus; stage: string; quality: ReviewQuality; allocatedCycles: number; completedCycles: number;
  selectedFinalRound: number | null; comments: ReviewComment[]; approvals: FigureApproval[];
  rounds: RoundResult[]; error: string | null; runId: string | null; manifest: ReviewManifest;
  providerVersions: { codex: string; anthropic: string }; exportedPaths: string[];
}
export interface ReviewContext { documents: Record<string, unknown[]>; slots: TextSlot[]; figures: ReviewFigure[]; bibliography: string; coverage: CoverageItem[]; packageHash: string }
export interface ReviewProgressEvent { at: string; kind: string; stage: string; attempt?: number }
export interface ReviewProgress {
  checkedAt: string;
  runStartedAt?: string;
  stageStartedAt?: string;
  activeCall?: { stage: string; provider: string; model: string; startedAt: string; attempt: number; timeoutMs: number; receivedCharacters?: number; lastOutputAt?: string };
  lastCompleted?: { stage: string; at: string };
  recent: ReviewProgressEvent[];
}
export interface ReviewResponseDocument { source: 'review' | 'revision'; path?: string; responses: ResponseItem[]; editedCommentIds: string[] }
export interface ReviewView { session: ReviewSession; root: string; responsesMarkdown: string; responseDocument?: ReviewResponseDocument; responseError?: string; changes: AppliedChange[]; progress?: ReviewProgress }
export interface ReviewAddress { projectPath: string; sessionId: string }
export const DEFAULT_REVIEWERS: ReviewerProfile[] = [
  { id: "R1", name: "Reviewer 1", focus: "Field relevance and contribution", original: "" },
  { id: "R2", name: "Reviewer 2", focus: "Methods and statistics", original: "" },
  { id: "R3", name: "Reviewer 3", focus: "Logic and reporting completeness", original: "" },
];

export type ReviewExportFormat = "json" | "md" | "qmd";
export type ReviewManuscriptExport = ReviewAddress & { round: number } & (
  | { format: "json" }
  | { format: "md" | "qmd"; documents: { filename: string; content: string }[] }
);

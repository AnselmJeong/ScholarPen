import type { AuthorObservation } from "./author-learning";
import type { PunctuationPolicy } from "./writing-preferences";

export const AUTHOR_STYLE_SERVICE = "scholarpen.author-style.profile@1";
export type StylePurpose = "draft" | "rewrite" | "translate" | "author-response" | "chat" | "review-evaluate" | "extract" | "style-learn";
export type StyleStrength = "off" | "light" | "normal" | "strong";
export interface StyleRule {
  id: string; instruction: string; language: string; genre: string; evidenceIds: string[];
  source: "learned" | "explicit"; status: "candidate" | "active" | "dismissed";
  support: "repeated" | "author-confirmed" | "insufficient";
}
export interface StyleProfile {
  id: string; name: string; authorId: string; revision: number;
  language: string; genre: string; rules: StyleRule[]; createdAt: string; updatedAt: string;
}
export interface StyleEvidence {
  id: string; profileId: string; authorId: string; kind: "author-sample" | "direct-edit" | "accepted" | "rejected";
  label: string; language: string; genre: string; text: string; hash: string;
  observedAt: number; observation?: AuthorObservation;
}
export interface StyleConfig {
  observe: boolean; autoAnalyze: boolean; localOnly: boolean; remoteConsent: boolean;
  autoApprove: boolean; applyToChat: boolean; strength: StyleStrength;
  skipNext: boolean;
  genre: "academic" | "explanation" | "any";
}
export interface StyleApplication {
  profileId: string; profileRevision: number; ruleIds: string[]; strength: StyleStrength;
  purpose: StylePurpose; at: string; model: string;
}
export interface StyleState {
  schemaVersion: 1; revision: number; authorId: string; profiles: StyleProfile[]; evidence: StyleEvidence[];
  activeProfileId: string | null; config: StyleConfig; exclusions: string[];
  history: StyleProfile[]; applications: StyleApplication[];
  migration: { sourceHash: string; at: string } | null;
  lastAnalysisHash: string;
  /** Explicit personal link. Null/absent and no project selection uses personal defaults. */
  personalProfileId?: string | null;
}
export interface PersonalStyleLibrary {
  schemaVersion: 1; revision: number; authorId: string; profiles: StyleProfile[];
  defaultProfileId: string | null;
  defaults: Array<{ language: string; genre: string; profileId: string }>;
  history: StyleProfile[];
}
export interface StyleView extends StyleState { provider: string; localProvider: boolean; remoteDeletionPending: boolean; personal?: PersonalStyleLibrary; error?: string }
export interface StyleRequest {
  purpose: StylePurpose; language?: string; genre?: string; profileId?: string; strength?: StyleStrength; model?: string;
  punctuation?: PunctuationPolicy;
}
export interface StyleContext { text: string; application?: StyleApplication; reason?: string }
export type StyleOperation = "view" | "create" | "update" | "delete" | "select" | "configure" | "addSample" | "forgetEvidence" | "analyze" | "export" | "import" | "restore" | "compare" | "observe" | "publishPersonal" | "setDefaults" | "linkPersonal" | "useDefaults";
export interface StyleCommand {
  projectPath: string; operation: StyleOperation; expectedRevision?: number; profileId?: string;
  payload?: unknown;
  scope?: "project" | "personal";
}
export interface StyleComparison {
  input: string; baseline: string; styled: string; application?: StyleApplication;
  warnings: string[]; profileRevision: number;
}
export const DEFAULT_STYLE_CONFIG: StyleConfig = {
  observe: false, autoAnalyze: false, localOnly: true, remoteConsent: false,
  autoApprove: false, applyToChat: false, strength: "normal", skipNext: false, genre: "academic",
};
export function detectStyleLanguage(text: string): string {
  return /[가-힣]/u.test(text) ? "ko" : /[a-zA-Z]/.test(text) ? "en" : "und";
}

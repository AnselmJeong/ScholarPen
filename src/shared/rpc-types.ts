// Shared RPC type definitions between Main process and Webview

import type { BibtexParseIssue } from "./bibtex-utils";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  context?: string;
  /** Disable qwen3 chain-of-thought — without this, content comes back empty. */
  think?: boolean;
}

export interface OllamaChatChunk {
  content: string;
  done: boolean;
}

export interface OllamaProxyResponse {
  status: number;
  statusText: string;
  contentType: string;
}

export interface CitationMetadata {
  doi: string;
  citekey: string;
  title: string;
  authors: string[];
  year: number;
  journal?: string;
  volume?: string;
  pages?: string;
  bibtex: string;
}

export interface ProjectFile {
  name: string;
  path: string;
  type: "manuscript" | "reference" | "figure" | "export";
}

export interface ProjectInfo {
  name: string;
  path: string;
  files: ProjectFile[];
  lastModified: number;
}

export interface BibliographyDeduplicationResult {
  bibtex: string;
  removedEntries: number;
  remappedCitations: number;
  updatedDocuments: number;
  citekeyRemap: Record<string, string>;
  backupPath: string | null;
}

export interface BibliographyMergeResult {
  bibtex: string;
  addedEntries: number;
  skippedDuplicates: Array<{
    citekey: string;
    duplicateOfCitekey: string;
  }>;
  backupPath: string | null;
}

export type BibliographyValidationStatus =
  | "valid"
  | "changes"
  | "unverified"
  | "unsupported"
  | "error";

export type BibliographyFieldValidationStatus =
  | "match"
  | "missing"
  | "mismatch"
  | "unavailable";

export interface BibliographyFieldValidation {
  field: "title" | "author" | "year" | "journal" | "volume" | "number" | "pages" | "doi";
  status: BibliographyFieldValidationStatus;
  current?: string;
  canonical?: string;
}

export interface JournalAbbreviationValidation {
  value: string;
  source: "nlm-iso" | "nlm-title" | "crossref-publisher";
  verified: boolean;
}

export interface BibliographyEntryValidation {
  citekey: string;
  entryType: string;
  status: BibliographyValidationStatus;
  matchMethod?: "doi" | "bibliographic";
  doi?: string;
  confidence?: number;
  fields: BibliographyFieldValidation[];
  journalAbbreviation?: JournalAbbreviationValidation;
  suggestedFields?: Record<string, string>;
  message?: string;
}

export interface BibliographyValidationProgress {
  stage: "scan" | "crossref" | "abbreviations" | "save";
  processed: number;
  total: number;
  message: string;
}

export interface BibliographyMaintenanceResult {
  bibtex: string;
  removedUnused: number;
  scannedDocuments: number;
  usedEntries: number;
  missingCitekeys: string[];
  backupPath: string | null;
  validations: BibliographyEntryValidation[];
}

export interface BibliographyRepairProposal {
  repairedBibtex: string;
  method: "deterministic" | "llm";
  issuesBefore: BibtexParseIssue[];
  provider?: LLMProvider;
  model?: string;
}

export interface OllamaStatus {
  connected: boolean;
  models: string[];
  activeModel: string | null;
}

export type LLMProvider = "ollama" | "anthropic" | "deepseek" | "openai";

export interface ModelProviderSettings {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  apiKeyRef?: string;
  enabled: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentThread {
  id: string;
  projectPath: string;
  title: string;
  provider: LLMProvider;
  model: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface AgentThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "complete" | "error" | "aborted";
  metadata?: Record<string, unknown>;
}

export interface AgentThreadWithMessages {
  thread: AgentThread;
  messages: AgentThreadMessage[];
}

export interface AgentSkill {
  id: string;
  name: string;
  kind: "skill" | "command";
  source: "scholarpen" | "project";
  sourcePath: string;
  description?: string;
}

export interface AgentMentionableFile {
  name: string;
  path: string;
  displayPath: string;
  kind: FileNodeKind;
}

export interface AgentStreamParams {
  message: string;
  projectPath: string | null;
  history: AgentMessage[];
  provider: LLMProvider;
  model: string;
  selectedSkillIds: string[];
  selectedFilePaths: string[];
  lang: "ko" | "en";
  projectSourcesEnabled?: boolean;
  analysisMode?: "deepen" | "find-citation";
  deepenContext?: {
    selectedText: string;
    beforeSelection: string;
    afterSelection: string;
  };
  citationContext?: {
    selectedText: string;
  };
}

export type FileNodeKind =
  | "document"
  | "reference"
  | "figure"
  | "pdf"
  | "note"
  | "export"
  | "folder"
  | "unknown";

export interface FileNode {
  name: string;
  path: string;
  kind: FileNodeKind;
  isDirectory: boolean;
  children?: FileNode[];
  lastModified: number;
  size?: number;
  /** Optional one-based page to reveal when opening a PDF reference. */
  initialPage?: number;
}

export interface ProjectSourcesStatus {
  digestCount: number;
  chunkCount: number;
  linkedPdfCount: number;
  indexedAt: number | null;
  indexing: boolean;
  lastError?: string;
}

export interface AppSettings {
  projectsRootDir: string;
  sidebarAgentProvider: LLMProvider;
  sidebarAgentModel: string;
  modelProviders: Record<LLMProvider, ModelProviderSettings>;
  ollamaBaseUrl: string;
  ollamaApiKey: string;
  ollamaDefaultModel: string;
  tinyfishApiKey: string;
  webSearchEnabled: boolean;
  anthropicApiKey: string;
  anthropicDefaultModel: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekDefaultModel: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiDefaultModel: string;
  openAlexApiKey: string;
  /** @deprecated Migrated to sidebarAgentProvider. */
  aiBackend?: "ollama" | "claude";
  /** @deprecated Migrated to anthropicDefaultModel/sidebarAgentModel. */
  claudeModel?: string;
  // Theme
  theme: "light" | "dark" | "system";
}

export type AppSettingsUpdate = Partial<AppSettings>;

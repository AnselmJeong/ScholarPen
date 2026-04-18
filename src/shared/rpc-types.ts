// Shared RPC type definitions between Main process and Webview

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
  type: "manuscript" | "reference" | "figure" | "export" | "kb";
}

export interface ProjectInfo {
  name: string;
  path: string;
  files: ProjectFile[];
  lastModified: number;
}

export interface KBDocument {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  sourceFile: string;
  indexedAt: number;
  chunkCount: number;
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata: {
    title: string;
    authors: string[];
    year?: number;
    doi?: string;
    sourceFile: string;
    chunkIndex: number;
    section?: string;
  };
}

export interface OllamaStatus {
  connected: boolean;
  models: string[];
  activeModel: string | null;
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
}

export interface AppSettings {
  projectsRootDir: string;
  ollamaBaseUrl: string;
  ollamaDefaultModel: string;
  ollamaEmbedModel: string;
  kbChunkSize: number;
  kbChunkOverlap: number;
  kbTopK: number;
  openAlexApiKey: string;
  // AI backend selection
  aiBackend: "ollama" | "claude";
  claudeModel: string;
  // Theme
  theme: "light" | "dark" | "system";
}

export type AppSettingsUpdate = Partial<AppSettings>;

export interface KBStatus {
  exists: boolean;
  kbRoot: string | null;
  pageCount: number;
  lastIndexed: number | null;
}

export interface KBGraphNode {
  id: string;       // filename stem (e.g. "precision-weighting")
  title: string;    // frontmatter title
  type: "concept" | "entity" | "source" | "overview" | "other";
  filePath: string; // absolute path to .md file
  degree: number;   // number of edges
}

export interface KBGraphEdge {
  source: string; // node id
  target: string; // node id
}

export interface KBGraph {
  nodes: KBGraphNode[];
  edges: KBGraphEdge[];
}

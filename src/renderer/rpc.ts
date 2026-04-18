// RPC client for calling Main process handlers from the Renderer
// Uses Electrobun's webview RPC bridge

import { Electroview } from "electrobun/view";
import type { ScholarRPC } from "../shared/scholar-rpc";
import type {
  OllamaStatus,
  ProjectInfo,
  CitationMetadata,
  SearchResult,
  FileNode,
  AppSettings,
  AppSettingsUpdate,
  KBStatus,
  KBGraph,
} from "../shared/rpc-types";

type MenuActionHandler = (action: string) => void;
type ImportMarkdownHandler = (content: string, suggestedFilename: string) => void;
type ClaudeChunkHandler = (content: string, done: boolean, sessionId?: string, slashCommands?: string[]) => void;
type AiChunkHandler = (content: string, done: boolean) => void;
type ProjectUpdatedHandler = (projectPath: string) => void;

// Create Electrobun RPC client for webview using defineRPC
// This properly initializes the transport system
const electrobun = new Electroview({
  rpc: Electroview.defineRPC<ScholarRPC>({
    maxRequestTime: 30_000,
    handlers: {
      requests: {},
      messages: {
        menuAction: ({ action }) => {
          console.log("[RPC] Received menuAction:", action);
          menuActionListeners.forEach((handler) => handler(action));
        },
        importMarkdownContent: ({ content, suggestedFilename }) => {
          console.log("[RPC] Received importMarkdownContent:", suggestedFilename);
          importMarkdownListeners.forEach((handler) => handler(content, suggestedFilename));
        },
        claudeChunk: ({ content, done, sessionId, slashCommands }) => {
          claudeChunkListeners.forEach((handler) => handler(content, done, sessionId, slashCommands));
        },
        aiChunk: ({ content, done }) => {
          aiChunkListeners.forEach((handler) => handler(content, done));
        },
        projectUpdated: ({ projectPath }) => {
          projectUpdatedListeners.forEach((handler) => handler(projectPath));
        },
      },
    },
  }),
});

// ── Menu action, import, Claude chunk, and project update listeners ──
const menuActionListeners: MenuActionHandler[] = [];
const importMarkdownListeners: ImportMarkdownHandler[] = [];
const claudeChunkListeners: ClaudeChunkHandler[] = [];
const aiChunkListeners: AiChunkHandler[] = [];
const projectUpdatedListeners: ProjectUpdatedHandler[] = [];

export function onMenuAction(handler: MenuActionHandler) {
  menuActionListeners.push(handler);
  return () => {
    const idx = menuActionListeners.indexOf(handler);
    if (idx >= 0) menuActionListeners.splice(idx, 1);
  };
}

export function onImportMarkdown(handler: ImportMarkdownHandler) {
  importMarkdownListeners.push(handler);
  return () => {
    const idx = importMarkdownListeners.indexOf(handler);
    if (idx >= 0) importMarkdownListeners.splice(idx, 1);
  };
}

export function onClaudeChunk(handler: ClaudeChunkHandler): () => void {
  claudeChunkListeners.push(handler);
  return () => {
    const idx = claudeChunkListeners.indexOf(handler);
    if (idx >= 0) claudeChunkListeners.splice(idx, 1);
  };
}

export function onAiChunk(handler: AiChunkHandler): () => void {
  aiChunkListeners.push(handler);
  return () => {
    const idx = aiChunkListeners.indexOf(handler);
    if (idx >= 0) aiChunkListeners.splice(idx, 1);
  };
}

export function onProjectUpdated(handler: ProjectUpdatedHandler): () => void {
  projectUpdatedListeners.push(handler);
  return () => {
    const idx = projectUpdatedListeners.indexOf(handler);
    if (idx >= 0) projectUpdatedListeners.splice(idx, 1);
  };
}

// Fallback mock for browser development
function mockRpc(method: string, _args: unknown[]): unknown {
  console.warn(`[RPC] Using mock for ${method}`);
  const mocks: Record<string, unknown> = {
    getOllamaStatus: { connected: false, models: [], activeModel: null },
    listProjects: [],
    createProject: { name: "demo", path: "/demo", files: [], lastModified: Date.now() },
    loadManuscript: [],
    loadDocument: [],
    loadBibtex: "",
    resolveDOI: null,
    searchCitations: [],
    searchKnowledgeBase: [],
    listProjectFiles: [],
    openFolderDialog: null,
    createDocument: "new-doc.scholarpen.json",
    exportFile: "/demo/exports/doc.md",
    readTextFile: "# Hello\n\nThis is a demo file.",
    readBinaryFile: "",
    renameFile: "/demo/documents/renamed.scholarpen.json",
    deleteFile: null,
    getSettings: {
      projectsRootDir: "",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaDefaultModel: "qwen3.5:cloud",
      ollamaEmbedModel: "nomic-embed-text",
      kbChunkSize: 512,
      kbChunkOverlap: 64,
      kbTopK: 5,
      aiBackend: "ollama",
      claudeModel: "claude-sonnet-4-6",
      theme: "system",
    },
    getOllamaModels: [],
    getKBGraph: { nodes: [], edges: [] },
  };
  return mocks[method] ?? null;
}

async function call<T>(method: string, params?: unknown): Promise<T> {
  try {
    // Use Electrobun's request proxy: electrobun.rpc.request.methodName(params)
    // Note: void-returning methods legitimately resolve to undefined — do NOT
    // treat undefined as an error here.
    const result = await (electrobun.rpc as any)?.request?.[method](params);
    return result as T;
  } catch (err) {
    console.warn(`[RPC] Electrobun RPC failed for ${method}, using mock:`, err);
    return mockRpc(method, []) as T;
  }
}

export const rpc = {
  getOllamaStatus: () => call<OllamaStatus>("getOllamaStatus"),
  listProjects: () => call<ProjectInfo[]>("listProjects"),
  openProject: (name: string) => call<ProjectInfo>("openProject", { name }),
  createProject: (name: string) => call<ProjectInfo>("createProject", { name }),
  // ── Document CRUD ─────────────────────────────────────
  saveDocument: (projectPath: string, filename: string, content: unknown) =>
    call<void>("saveDocument", { projectPath, filename, content }),
  loadDocument: (projectPath: string, filename: string) =>
    call<unknown>("loadDocument", { projectPath, filename }),
  createDocument: (projectPath: string, filename: string, content?: unknown) =>
    call<string>("createDocument", { projectPath, filename, content }),
  // ── Legacy ────────────────────────────────────────────
  saveManuscript: (projectPath: string, content: unknown) =>
    call<void>("saveManuscript", { projectPath, content }),
  loadManuscript: (projectPath: string) =>
    call<unknown>("loadManuscript", { projectPath }),
  // ── BibTeX ────────────────────────────────────────────
  saveBibtex: (projectPath: string, bibtex: string) =>
    call<void>("saveBibtex", { projectPath, bibtex }),
  loadBibtex: (projectPath: string) => call<string>("loadBibtex", { projectPath }),
  // ── Citation ──────────────────────────────────────────
  resolveDOI: (doi: string) => call<CitationMetadata>("resolveDOI", { doi }),
  searchCitations: (query: string) =>
    call<CitationMetadata[]>("searchCitations", { query }),
  searchKnowledgeBase: (projectPath: string, query: string) =>
    call<SearchResult[]>("searchKnowledgeBase", { projectPath, query }),
  // ── File Tree ─────────────────────────────────────────
  openProjectByPath: (projectPath: string) =>
    call<ProjectInfo>("openProjectByPath", { projectPath }),
  listProjectFiles: (projectPath: string) =>
    call<FileNode[]>("listProjectFiles", { projectPath }),
  openFolderDialog: () => call<string | null>("openFolderDialog"),
  // ── Export ────────────────────────────────────────────
  exportFile: (projectPath: string, filename: string, content: string) =>
    call<string>("exportFile", { projectPath, filename, content }),
  // ── File Management ───────────────────────────────────
  readTextFile: (filePath: string) =>
    call<string>("readTextFile", { filePath }),
  readBinaryFile: (filePath: string) =>
    call<string>("readBinaryFile", { filePath }),
  renameFile: (filePath: string, newName: string) =>
    call<string>("renameFile", { filePath, newName }),
  deleteFile: (filePath: string) =>
    call<void>("deleteFile", { filePath }),
  // ── Settings ──────────────────────────────────────────
  getSettings: () => call<AppSettings>("getSettings"),
  saveSettings: (settings: AppSettingsUpdate) =>
    call<void>("saveSettings", { settings }),
  // ── Knowledge Base ────────────────────────────────────
  getKBStatus: (projectPath: string) =>
    call<KBStatus>("getKBStatus", { projectPath }),
  rebuildKBIndex: (projectPath: string) =>
    call<void>("rebuildKBIndex", { projectPath }),
  getKBGraph: (projectPath: string) =>
    call<KBGraph>("getKBGraph", { projectPath }),
  // ── Ollama model list ─────────────────────────────────
  getOllamaModels: () => call<string[]>("getOllamaModels"),
  openExternal: (url: string) => call<void>("openExternal", { url }),
  // ── Claude CLI streaming ──────────────────────────────
  getClaudeSlashCommands: (projectPath?: string) => call<string[]>("getClaudeSlashCommands", { projectPath }),
  claudeStream: (
    message: string,
    sessionId: string | null,
    projectPath: string | null,
    kbEnabled?: boolean,
    lang?: "ko" | "en"
  ) => call<void>("claudeStream", { message, sessionId, projectPath, kbEnabled, lang }),
  // ── Streaming AI (Ollama, proxied through bun to bypass CORS) ──
  // Listen for chunks with `onAiChunk(...)`; this call is fire-and-forget.
  generateTextStream: (
    model: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    think?: boolean
  ) => call<void>("generateTextStream", { model, messages, think }),
  abortAiStream: () => call<void>("abortAiStream"),
};
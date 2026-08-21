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
  AgentSkill,
  AgentMentionableFile,
  AgentStreamParams,
  AgentThread,
  AgentThreadMessage,
  AgentThreadWithMessages,
  OllamaProxyResponse,
  BibliographyDeduplicationResult,
  BibliographyMaintenanceResult,
  BibliographyValidationProgress,
} from "../shared/rpc-types";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_EMBEDDING_BASE_URL,
} from "../shared/ollama-connection";

type MenuActionHandler = (action: string) => void;
type ImportMarkdownHandler = (content: string, suggestedFilename: string) => void;
type AiChunkHandler = (content: string, done: boolean) => void;
type AgentChunkHandler = (content: string, done: boolean) => void;
type OllamaProxyChunkHandler = (payload: { requestId: string; content: string; done: boolean; error?: string }) => void;
type ProjectUpdatedHandler = (projectPath: string, filePath?: string) => void;
type BibliographyValidationProgressHandler = (progress: BibliographyValidationProgress) => void;

const strictRpcMethods = new Set([
  "createProject",
  "openProject",
  "openProjectByPath",
  "saveDocument",
  "saveDocuments",
  "createDocument",
  "saveManuscript",
  "saveBibtex",
  "saveBibtexRaw",
  "deduplicateBibliography",
  "validateAndCleanBibliography",
  "exportFile",
  "renameFile",
  "deleteFile",
  "saveSettings",
  "rebuildKBIndex",
  "createAgentThread",
  "deleteAgentThread",
  "saveAgentThreadMessage",
  "abortAgentStream",
  "abortAiStream",
  "startOllamaOpenAIProxy",
  "abortOllamaOpenAIProxy",
  "listProviderModels",
]);

// Create Electrobun RPC client for webview using defineRPC
// This properly initializes the transport system
const electrobun = new Electroview({
  rpc: Electroview.defineRPC<ScholarRPC>({
    maxRequestTime: 600_000,
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
        aiChunk: ({ content, done }) => {
          aiChunkListeners.forEach((handler) => handler(content, done));
        },
        agentChunk: ({ content, done }) => {
          agentChunkListeners.forEach((handler) => handler(content, done));
        },
        ollamaProxyChunk: (payload) => {
          ollamaProxyChunkListeners.forEach((handler) => handler(payload));
        },
        projectUpdated: ({ projectPath, filePath }) => {
          projectUpdatedListeners.forEach((handler) => handler(projectPath, filePath));
        },
        bibliographyValidationProgress: (progress) => {
          bibliographyValidationProgressListeners.forEach((handler) => handler(progress));
        },
      },
    },
  }),
});

// ── Menu action, import, stream chunk, and project update listeners ──
const menuActionListeners: MenuActionHandler[] = [];
const importMarkdownListeners: ImportMarkdownHandler[] = [];
const aiChunkListeners: AiChunkHandler[] = [];
const agentChunkListeners: AgentChunkHandler[] = [];
const ollamaProxyChunkListeners: OllamaProxyChunkHandler[] = [];
const projectUpdatedListeners: ProjectUpdatedHandler[] = [];
const bibliographyValidationProgressListeners: BibliographyValidationProgressHandler[] = [];

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

export function onAiChunk(handler: AiChunkHandler): () => void {
  aiChunkListeners.push(handler);
  return () => {
    const idx = aiChunkListeners.indexOf(handler);
    if (idx >= 0) aiChunkListeners.splice(idx, 1);
  };
}

export function onAgentChunk(handler: AgentChunkHandler): () => void {
  agentChunkListeners.push(handler);
  return () => {
    const idx = agentChunkListeners.indexOf(handler);
    if (idx >= 0) agentChunkListeners.splice(idx, 1);
  };
}

export function onOllamaProxyChunk(handler: OllamaProxyChunkHandler): () => void {
  ollamaProxyChunkListeners.push(handler);
  return () => {
    const idx = ollamaProxyChunkListeners.indexOf(handler);
    if (idx >= 0) ollamaProxyChunkListeners.splice(idx, 1);
  };
}

export function onProjectUpdated(handler: ProjectUpdatedHandler): () => void {
  projectUpdatedListeners.push(handler);
  return () => {
    const idx = projectUpdatedListeners.indexOf(handler);
    if (idx >= 0) projectUpdatedListeners.splice(idx, 1);
  };
}

export function onBibliographyValidationProgress(
  handler: BibliographyValidationProgressHandler,
): () => void {
  bibliographyValidationProgressListeners.push(handler);
  return () => {
    const idx = bibliographyValidationProgressListeners.indexOf(handler);
    if (idx >= 0) bibliographyValidationProgressListeners.splice(idx, 1);
  };
}

// Fallback mock for browser development
function mockRpc(method: string, _args: unknown[]): unknown {
  console.warn(`[RPC] Using mock for ${method}`);
  if (method === "confirmAction") {
    const params = _args[0] as {
      message?: string;
      detail?: string;
    } | undefined;
    const prompt = [params?.message, params?.detail].filter(Boolean).join("\n\n");
    return typeof window !== "undefined" ? window.confirm(prompt) : false;
  }
  const mocks: Record<string, unknown> = {
    getOllamaStatus: { connected: false, models: [], activeModel: null },
    listProjects: [],
    createProject: { name: "demo", path: "/demo", files: [], lastModified: Date.now() },
    loadManuscript: [],
    loadDocument: [],
    loadBibtex: "",
    saveBibtexRaw: null,
    deduplicateBibliography: {
      bibtex: "",
      removedEntries: 0,
      remappedCitations: 0,
      updatedDocuments: 0,
      citekeyRemap: {},
      backupPath: null,
    },
    validateAndCleanBibliography: {
      bibtex: "",
      removedUnused: 0,
      scannedDocuments: 0,
      usedEntries: 0,
      missingCitekeys: [],
      backupPath: null,
      validations: [],
    },
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
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
      ollamaApiKey: "",
      ollamaWebSearchEnabled: false,
        ollamaDefaultModel: "qwen3.5:397b",
      ollamaEmbeddingBaseUrl: DEFAULT_OLLAMA_EMBEDDING_BASE_URL,
      ollamaEmbedModel: "nomic-embed-text",
      sidebarAgentProvider: "ollama",
      sidebarAgentModel: "qwen3.5:397b",
      modelProviders: {
        ollama: { provider: "ollama", model: "qwen3.5:397b", baseUrl: DEFAULT_OLLAMA_BASE_URL, enabled: true },
        anthropic: { provider: "anthropic", model: "claude-sonnet-4-5", enabled: false },
        deepseek: { provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", enabled: false },
        openai: { provider: "openai", model: "gpt-5.2", baseUrl: "https://api.openai.com/v1", enabled: false },
      },
      anthropicApiKey: "",
      anthropicDefaultModel: "claude-sonnet-4-5",
      deepseekApiKey: "",
      deepseekBaseUrl: "https://api.deepseek.com",
      deepseekDefaultModel: "deepseek-chat",
      openaiApiKey: "",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiDefaultModel: "gpt-5.2",
      kbChunkSize: 512,
      kbChunkOverlap: 64,
      kbTopK: 5,
      theme: "system",
    },
    getOllamaModels: [],
    listProviderModels: [],
    listAgentSkills: [],
    listAgentMentionableFiles: [],
    listAgentThreads: [],
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
    if (strictRpcMethods.has(method)) {
      console.error(`[RPC] Electrobun RPC failed for ${method}:`, err);
      throw err;
    }
    console.warn(`[RPC] Electrobun RPC failed for ${method}, using mock:`, err);
    return mockRpc(method, [params]) as T;
  }
}

export const rpc = {
  getOllamaStatus: () => call<OllamaStatus>("getOllamaStatus"),
  confirmAction: (options: {
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
  }) => call<boolean>("confirmAction", options),
  listProjects: () => call<ProjectInfo[]>("listProjects"),
  openProject: (name: string) => call<ProjectInfo>("openProject", { name }),
  createProject: (name: string) => call<ProjectInfo>("createProject", { name }),
  // ── Document CRUD ─────────────────────────────────────
  saveDocument: (projectPath: string, filename: string, content: unknown) =>
    call<void>("saveDocument", { projectPath, filename, content }),
  saveDocuments: (
    projectPath: string,
    documents: Array<{ filename: string; content: unknown }>,
  ) => call<void>("saveDocuments", { projectPath, documents }),
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
  saveBibtexRaw: (projectPath: string, bibtex: string) =>
    call<void>("saveBibtexRaw", { projectPath, bibtex }),
  loadBibtex: (projectPath: string) => call<string>("loadBibtex", { projectPath }),
  deduplicateBibliography: (projectPath: string, bibtex: string) =>
    call<BibliographyDeduplicationResult>("deduplicateBibliography", {
      projectPath,
      bibtex,
    }),
  validateAndCleanBibliography: (projectPath: string, bibtex: string) =>
    call<BibliographyMaintenanceResult>("validateAndCleanBibliography", {
      projectPath,
      bibtex,
    }),
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
  listProviderModels: (provider: AppSettings["sidebarAgentProvider"], settings?: AppSettingsUpdate) =>
    call<string[]>("listProviderModels", { provider, settings }),
  openExternal: (url: string) => call<void>("openExternal", { url }),
  // ── Scholar Agent streaming ───────────────────────────
  listAgentSkills: (projectPath?: string) =>
    call<AgentSkill[]>("listAgentSkills", { projectPath }),
  listAgentMentionableFiles: (projectPath: string) =>
    call<AgentMentionableFile[]>("listAgentMentionableFiles", { projectPath }),
  listAgentThreads: (projectPath: string) =>
    call<AgentThread[]>("listAgentThreads", { projectPath }),
  createAgentThread: (
    projectPath: string,
    provider: AppSettings["sidebarAgentProvider"],
    model: string,
    title?: string,
    metadata?: Record<string, unknown>,
  ) => call<AgentThread>("createAgentThread", { projectPath, provider, model, title, metadata }),
  getAgentThread: (projectPath: string, threadId: string) =>
    call<AgentThreadWithMessages>("getAgentThread", { projectPath, threadId }),
  deleteAgentThread: (projectPath: string, threadId: string) =>
    call<void>("deleteAgentThread", { projectPath, threadId }),
  saveAgentThreadMessage: (
    projectPath: string,
    threadId: string,
    role: AgentThreadMessage["role"],
    content: string,
    status?: AgentThreadMessage["status"],
    metadata?: Record<string, unknown>,
  ) => call<AgentThreadMessage>("saveAgentThreadMessage", { projectPath, threadId, role, content, status, metadata }),
  agentStream: (params: AgentStreamParams) => call<void>("agentStream", params),
  abortAgentStream: () => call<void>("abortAgentStream"),
  // ── Streaming AI (Ollama, proxied through bun to bypass CORS) ──
  // Listen for chunks with `onAiChunk(...)`; this call is fire-and-forget.
  generateTextStream: (
    model: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    think?: boolean
  ) => call<void>("generateTextStream", { model, messages, think }),
  abortAiStream: () => call<void>("abortAiStream"),
  startOllamaOpenAIProxy: (requestId: string, body: string) =>
    call<OllamaProxyResponse>("startOllamaOpenAIProxy", { requestId, body }),
  abortOllamaOpenAIProxy: (requestId: string) =>
    call<void>("abortOllamaOpenAIProxy", { requestId }),
};

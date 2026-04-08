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
} from "../shared/rpc-types";

// Create Electrobun RPC client for webview using defineRPC
// This properly initializes the transport system
const electrobun = new Electroview({
  rpc: Electroview.defineRPC({
    handlers: {},
  }),
});

// Fallback mock for browser development
function mockRpc(method: string, _args: unknown[]): unknown {
  console.warn(`[RPC] Using mock for ${method}`);
  const mocks: Record<string, unknown> = {
    getOllamaStatus: { connected: false, models: [], activeModel: null },
    listProjects: [],
    createProject: { name: "demo", path: "/demo", files: [], lastModified: Date.now() },
    loadManuscript: [],
    loadBibtex: "",
    resolveDOI: null,
    searchCitations: [],
    searchKnowledgeBase: [],
    listProjectFiles: [],
    openFolderDialog: null,
    getSettings: {
      projectsRootDir: "",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaDefaultModel: "qwen3.5:cloud",
      ollamaEmbedModel: "nomic-embed-text",
      kbChunkSize: 512,
      kbChunkOverlap: 64,
      kbTopK: 5,
    },
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
  saveManuscript: (projectPath: string, content: unknown) =>
    call<void>("saveManuscript", { projectPath, content }),
  loadManuscript: (projectPath: string) =>
    call<unknown>("loadManuscript", { projectPath }),
  saveBibtex: (projectPath: string, bibtex: string) =>
    call<void>("saveBibtex", { projectPath, bibtex }),
  loadBibtex: (projectPath: string) => call<string>("loadBibtex", { projectPath }),
  resolveDOI: (doi: string) => call<CitationMetadata>("resolveDOI", { doi }),
  searchCitations: (query: string) =>
    call<CitationMetadata[]>("searchCitations", { query }),
  searchKnowledgeBase: (projectPath: string, query: string) =>
    call<SearchResult[]>("searchKnowledgeBase", { projectPath, query }),
  // Streaming chat - calls Bun which proxies to Ollama
  openProjectByPath: (projectPath: string) =>
    call<ProjectInfo>("openProjectByPath", { projectPath }),
  listProjectFiles: (projectPath: string) =>
    call<FileNode[]>("listProjectFiles", { projectPath }),
  openFolderDialog: () => call<string | null>("openFolderDialog"),
  getSettings: () => call<AppSettings>("getSettings"),
  saveSettings: (settings: AppSettingsUpdate) =>
    call<void>("saveSettings", { settings }),
  generateTextStream: (
    model: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (content: string) => void
  ) => {
    // Register message listener for aiChunk messages
    (electrobun.rpc as any)?.addMessageListener?.("aiChunk", (payload: { content: string }) => {
      onChunk(payload.content);
    });
    return call<void>("generateTextStream", { model, messages });
  },
};

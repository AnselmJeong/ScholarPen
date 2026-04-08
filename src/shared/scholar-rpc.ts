import type { ElectrobunRPCSchema, RPCSchema } from "electrobun/bun";
import type {
  OllamaStatus,
  ProjectInfo,
  CitationMetadata,
  SearchResult,
  FileNode,
  AppSettings,
  AppSettingsUpdate,
} from "./rpc-types";

// Requests Bun handles (Webview → Bun)
type BunRequests = RPCSchema<{
  requests: {
    getOllamaStatus: { params: void; response: OllamaStatus };
    listProjects: { params: void; response: ProjectInfo[] };
    openProject: { params: { name: string }; response: ProjectInfo };
    openProjectByPath: { params: { projectPath: string }; response: ProjectInfo };
    createProject: { params: { name: string }; response: ProjectInfo };
    saveManuscript: { params: { projectPath: string; content: unknown }; response: void };
    loadManuscript: { params: { projectPath: string }; response: unknown };
    saveBibtex: { params: { projectPath: string; bibtex: string }; response: void };
    loadBibtex: { params: { projectPath: string }; response: string };
    resolveDOI: { params: { doi: string }; response: CitationMetadata };
    searchCitations: { params: { query: string }; response: CitationMetadata[] };
    searchKnowledgeBase: {
      params: { projectPath: string; query: string };
      response: SearchResult[];
    };
    generateTextStream: {
      params: { model: string; messages: Array<{ role: string; content: string }> };
      response: void;
    };
    listProjectFiles: { params: { projectPath: string }; response: FileNode[] };
    openFolderDialog: { params: void; response: string | null };
    getSettings: { params: void; response: AppSettings };
    saveSettings: { params: { settings: AppSettingsUpdate }; response: void };
  };
  messages: {
    aiChunk: { content: string };
  };
}>;

// Requests Webview handles (Bun → Webview) — mostly events/streams
type WebviewRequests = RPCSchema<{
  requests: Record<never, { params: unknown; response: unknown }>;
  messages: {
    aiChunk: { content: string; done: boolean };
    projectUpdated: { projectPath: string };
  };
}>;

export interface ScholarRPC extends ElectrobunRPCSchema {
  bun: BunRequests;
  webview: WebviewRequests;
}

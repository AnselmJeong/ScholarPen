import type { ElectrobunRPCSchema, RPCSchema } from "electrobun/bun";
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
} from "./rpc-types";

// Requests Bun handles (Webview → Bun)
type BunRequests = RPCSchema<{
  requests: {
    getOllamaStatus: { params: void; response: OllamaStatus };
    listProjects: { params: void; response: ProjectInfo[] };
    openProject: { params: { name: string }; response: ProjectInfo };
    openProjectByPath: { params: { projectPath: string }; response: ProjectInfo };
    createProject: { params: { name: string }; response: ProjectInfo };
    // Multi-document support
    saveDocument: { params: { projectPath: string; filename: string; content: unknown }; response: void };
    loadDocument: { params: { projectPath: string; filename: string }; response: unknown };
    createDocument: { params: { projectPath: string; filename: string; content?: unknown }; response: string };
    // Legacy (backward compat)
    saveManuscript: { params: { projectPath: string; content: unknown }; response: void };
    loadManuscript: { params: { projectPath: string }; response: unknown };
    // BibTeX
    saveBibtex: { params: { projectPath: string; bibtex: string }; response: void };
    saveBibtexRaw: { params: { projectPath: string; bibtex: string }; response: void };
    loadBibtex: { params: { projectPath: string }; response: string };
    // Citations
    resolveDOI: { params: { doi: string }; response: CitationMetadata };
    searchCitations: { params: { query: string }; response: CitationMetadata[] };
    searchKnowledgeBase: {
      params: { projectPath: string; query: string };
      response: SearchResult[];
    };
    getKBStatus: { params: { projectPath: string }; response: KBStatus };
    rebuildKBIndex: { params: { projectPath: string }; response: void };
    getKBGraph: { params: { projectPath: string }; response: KBGraph };
    generateTextStream: {
      params: {
        model: string;
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        think?: boolean;
      };
      response: void;
    };
    abortAiStream: { params: void; response: void };
    // File system
    listProjectFiles: { params: { projectPath: string }; response: FileNode[] };
    openFolderDialog: { params: void; response: string | null };
    // Export
    exportFile: { params: { projectPath: string; filename: string; content: string }; response: string };
    // File management
    readTextFile: { params: { filePath: string }; response: string };
    readBinaryFile: { params: { filePath: string }; response: string };
    renameFile: { params: { filePath: string; newName: string }; response: string };
    deleteFile: { params: { filePath: string }; response: void };
    // Settings
    getSettings: { params: void; response: AppSettings };
    saveSettings: { params: { settings: AppSettingsUpdate }; response: void };
    // Claude CLI streaming
    claudeStream: {
      params: {
        message: string;
        sessionId: string | null;
        projectPath: string | null;
        kbEnabled?: boolean;
        lang?: "ko" | "en";
      };
      response: void;
    };
    getClaudeSlashCommands: { params: { projectPath?: string }; response: string[] };
    abortClaudeStream: { params: void; response: void };
    getOllamaModels: { params: void; response: string[] };
    openExternal: { params: { url: string }; response: void };
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
    claudeChunk: { content: string; done: boolean; sessionId?: string; slashCommands?: string[] };
    projectUpdated: { projectPath: string; filePath?: string };
    menuAction: { action: string };
    importMarkdownContent: { content: string; suggestedFilename: string };
  };
}>;

export interface ScholarRPC extends ElectrobunRPCSchema {
  bun: BunRequests;
  webview: WebviewRequests;
}

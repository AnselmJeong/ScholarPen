import type { ElectrobunRPCSchema, RPCSchema } from "electrobun/bun";
import type {
  OllamaStatus,
  ProjectInfo,
  CitationMetadata,
  FileNode,
  AppSettings,
  AppSettingsUpdate,
  AgentSkill,
  AgentMentionableFile,
  AgentStreamParams,
  AgentThread,
  AgentThreadMessage,
  AgentThreadWithMessages,
  OllamaProxyResponse,
  BibliographyDeduplicationResult,
  BibliographyMergeResult,
  BibliographyMaintenanceResult,
  BibliographyValidationProgress,
  BibliographyRepairProposal,
  ProjectSourcesStatus,
} from "./rpc-types";

// Requests Bun handles (Webview → Bun)
type BunRequests = RPCSchema<{
  requests: {
    getOllamaStatus: { params: void; response: OllamaStatus };
    confirmAction: {
      params: {
        title: string;
        message: string;
        detail?: string;
        confirmLabel?: string;
      };
      response: boolean;
    };
    listProjects: { params: void; response: ProjectInfo[] };
    openProject: { params: { name: string }; response: ProjectInfo };
    openProjectByPath: { params: { projectPath: string }; response: ProjectInfo };
    createProject: { params: { name: string }; response: ProjectInfo };
    // Multi-document support
    saveDocument: { params: { projectPath: string; filename: string; content: unknown }; response: void };
    saveDocuments: {
      params: { projectPath: string; documents: Array<{ filename: string; content: unknown }> };
      response: void;
    };
    loadDocument: { params: { projectPath: string; filename: string }; response: unknown };
    createDocument: { params: { projectPath: string; filename: string; content?: unknown }; response: string };
    // Legacy (backward compat)
    saveManuscript: { params: { projectPath: string; content: unknown }; response: void };
    loadManuscript: { params: { projectPath: string }; response: unknown };
    // BibTeX
    saveBibtex: { params: { projectPath: string; bibtex: string }; response: void };
    saveBibtexRaw: { params: { projectPath: string; bibtex: string }; response: void };
    saveBibtexValidated: {
      params: { projectPath: string; bibtex: string; expectedCurrentBibtex: string };
      response: void;
    };
    loadBibtex: { params: { projectPath: string }; response: string };
    mergeBibtex: {
      params: { projectPath: string; importedBibtex: string };
      response: BibliographyMergeResult;
    };
    proposeBibliographyRepair: {
      params: { projectPath: string; bibtex: string; mode: "deterministic" | "llm" };
      response: BibliographyRepairProposal;
    };
    applyBibliographyRepair: {
      params: { projectPath: string; originalBibtex: string; repairedBibtex: string };
      response: string | null;
    };
    deduplicateBibliography: {
      params: { projectPath: string; bibtex: string };
      response: BibliographyDeduplicationResult;
    };
    validateAndCleanBibliography: {
      params: { projectPath: string; bibtex: string };
      response: BibliographyMaintenanceResult;
    };
    // Citations
    resolveDOI: { params: { doi: string }; response: CitationMetadata };
    searchCitations: { params: { query: string }; response: CitationMetadata[] };
    generateTextStream: {
      params: {
        model: string;
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        think?: boolean;
      };
      response: void;
    };
    abortAiStream: { params: void; response: void };
    startOllamaOpenAIProxy: {
      params: { requestId: string; body: string };
      response: OllamaProxyResponse;
    };
    abortOllamaOpenAIProxy: { params: { requestId: string }; response: void };
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
    listAgentSkills: { params: { projectPath?: string }; response: AgentSkill[] };
    listAgentMentionableFiles: { params: { projectPath: string }; response: AgentMentionableFile[] };
    getProjectSourcesStatus: { params: { projectPath: string }; response: ProjectSourcesStatus };
    rebuildProjectSourcesIndex: { params: { projectPath: string }; response: ProjectSourcesStatus };
    listAgentThreads: { params: { projectPath: string }; response: AgentThread[] };
    createAgentThread: {
      params: { projectPath: string; provider: AppSettings["sidebarAgentProvider"]; model: string; title?: string; metadata?: Record<string, unknown> };
      response: AgentThread;
    };
    getAgentThread: { params: { projectPath: string; threadId: string }; response: AgentThreadWithMessages };
    deleteAgentThread: { params: { projectPath: string; threadId: string }; response: void };
    saveAgentThreadMessage: {
      params: {
        projectPath: string;
        threadId: string;
        role: "user" | "assistant";
        content: string;
        status?: AgentThreadMessage["status"];
        metadata?: Record<string, unknown>;
      };
      response: AgentThreadMessage;
    };
    agentStream: { params: AgentStreamParams; response: void };
    abortAgentStream: { params: void; response: void };
    getOllamaModels: { params: void; response: string[] };
    listProviderModels: { params: { provider: AppSettings["sidebarAgentProvider"]; settings?: AppSettingsUpdate }; response: string[] };
    openExternal: { params: { url: string }; response: void };
  };
  messages: {
    aiChunk: { content: string };
    agentChunk: { content: string; done: boolean };
    bibliographyValidationProgress: BibliographyValidationProgress;
  };
}>;

// Requests Webview handles (Bun → Webview) — mostly events/streams
type WebviewRequests = RPCSchema<{
  requests: Record<never, { params: unknown; response: unknown }>;
  messages: {
    aiChunk: { content: string; done: boolean };
    ollamaProxyChunk: { requestId: string; content: string; done: boolean; error?: string };
    agentChunk: { content: string; done: boolean };
    projectUpdated: { projectPath: string; filePath?: string };
    menuAction: { action: string };
    importMarkdownContent: { content: string; suggestedFilename: string };
    bibliographyValidationProgress: BibliographyValidationProgress;
  };
}>;

export interface ScholarRPC extends ElectrobunRPCSchema {
  bun: BunRequests;
  webview: WebviewRequests;
}

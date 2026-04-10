import type {
  OllamaChatRequest,
  CitationMetadata,
  ProjectInfo,
  SearchResult,
  OllamaStatus,
} from "../../shared/rpc-types";
import { ollamaClient } from "../ollama/client";
import { citationClient } from "../citation/client";
import { fileSystem } from "../fs/manager";

export const rpcHandlers = {
  // ── Ollama ──────────────────────────────────────────────
  async getOllamaStatus(): Promise<OllamaStatus> {
    return ollamaClient.getStatus();
  },

  async generateTextStream(
    req: OllamaChatRequest,
    onChunk: (content: string) => void
  ): Promise<void> {
    await ollamaClient.streamChat(req, onChunk);
  },

  // ── File System ─────────────────────────────────────────
  async listProjects(): Promise<ProjectInfo[]> {
    return fileSystem.listProjects();
  },

  async openProject(name: string): Promise<ProjectInfo> {
    return fileSystem.openProject(name);
  },

  async createProject(name: string): Promise<ProjectInfo> {
    return fileSystem.createProject(name);
  },

  // ── Document CRUD (multi-document) ─────────────────────
  async saveDocument(params: { projectPath: string; filename: string; content: unknown }): Promise<void> {
    await fileSystem.saveDocument(params.projectPath, params.filename, params.content);
  },

  async loadDocument(params: { projectPath: string; filename: string }): Promise<unknown> {
    return fileSystem.loadDocument(params.projectPath, params.filename);
  },

  async createDocument(params: { projectPath: string; filename: string; content?: unknown }): Promise<string> {
    return fileSystem.createDocument(params.projectPath, params.filename, params.content);
  },

  // ── Legacy (backward compat) ────────────────────────────
  async saveManuscript(params: { projectPath: string; content: unknown }): Promise<void> {
    await fileSystem.saveManuscript(params.projectPath, params.content);
  },

  async loadManuscript(params: { projectPath: string }): Promise<unknown> {
    return fileSystem.loadManuscript(params.projectPath);
  },

  // ── BibTeX ──────────────────────────────────────────────
  async saveBibtex(params: { projectPath: string; bibtex: string }): Promise<void> {
    await fileSystem.saveBibtex(params.projectPath, params.bibtex);
  },

  async loadBibtex(params: { projectPath: string }): Promise<string> {
    return fileSystem.loadBibtex(params.projectPath);
  },

  // ── Citation ────────────────────────────────────────────
  async resolveDOI(doi: string): Promise<CitationMetadata> {
    return citationClient.resolveDOI(doi);
  },

  async searchCitations(query: string): Promise<CitationMetadata[]> {
    return citationClient.searchOpenAlex(query);
  },

  // ── Knowledge Base (placeholder for Phase 4) ────────────
  async searchKnowledgeBase(
    _params: { projectPath: string; query: string }
  ): Promise<SearchResult[]> {
    return [];
  },

  // ── File Tree ───────────────────────────────────────────
  async listProjectFiles(params: { projectPath: string }): Promise<import("../../shared/rpc-types").FileNode[]> {
    return fileSystem.listProjectFiles(params.projectPath);
  },

  async openFolderDialog(): Promise<string | null> {
    return fileSystem.openFolderDialog();
  },

  // ── Export ───────────────────────────────────────────────
  async exportFile(params: { projectPath: string; filename: string; content: string }): Promise<string> {
    return fileSystem.exportFile(params.projectPath, params.filename, params.content);
  },

  // ── File Management ──────────────────────────────────────
  async readTextFile(params: { filePath: string }): Promise<string> {
    return fileSystem.readTextFile(params.filePath);
  },

  async renameFile(params: { filePath: string; newName: string }): Promise<string> {
    return fileSystem.renameFile(params.filePath, params.newName);
  },

  async deleteFile(params: { filePath: string }): Promise<void> {
    await fileSystem.deleteFile(params.filePath);
  },

  // ── Settings ────────────────────────────────────────────
  async getSettings(): Promise<import("../../shared/rpc-types").AppSettings> {
    return fileSystem.getSettings();
  },

  async saveSettings(params: { settings: import("../../shared/rpc-types").AppSettingsUpdate }): Promise<void> {
    await fileSystem.saveSettings(params.settings);
  },
} as const;

export type RpcHandlers = typeof rpcHandlers;
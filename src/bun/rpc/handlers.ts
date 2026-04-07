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

  async saveManuscript(projectPath: string, content: unknown): Promise<void> {
    await fileSystem.saveManuscript(projectPath, content);
  },

  async loadManuscript(projectPath: string): Promise<unknown> {
    return fileSystem.loadManuscript(projectPath);
  },

  async saveBibtex(projectPath: string, bibtex: string): Promise<void> {
    await fileSystem.saveBibtex(projectPath, bibtex);
  },

  async loadBibtex(projectPath: string): Promise<string> {
    return fileSystem.loadBibtex(projectPath);
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
    _projectPath: string,
    _query: string
  ): Promise<SearchResult[]> {
    return [];
  },
} as const;

export type RpcHandlers = typeof rpcHandlers;

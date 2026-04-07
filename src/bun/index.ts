import { BrowserView, BrowserWindow } from "electrobun/bun";
import { ollamaClient } from "./ollama/client";
import { citationClient } from "./citation/client";
import { fileSystem } from "./fs/manager";
import type { ScholarRPC } from "../shared/scholar-rpc";

async function getMainViewUrl(): Promise<string> {
  // In development, try to use Vite HMR server
  try {
    const res = await fetch("http://localhost:5173", {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      console.log("[ScholarPen] Using Vite HMR at localhost:5173");
      return "http://localhost:5173";
    }
  } catch {
    // Vite not running, fall through
  }
  return "views://mainview/index.html";
}

async function main() {
  const url = await getMainViewUrl();

  // Define typed RPC for communication between Bun main ↔ Webview
  const scholarRpc = BrowserView.defineRPC<ScholarRPC>({
    maxRequestTime: 30_000,
    handlers: {
      requests: {
        getOllamaStatus: () => ollamaClient.getStatus(),

        listProjects: () => fileSystem.listProjects(),

        openProject: ({ name }) => fileSystem.openProject(name),

        createProject: ({ name }) => fileSystem.createProject(name),

        saveManuscript: ({ projectPath, content }) =>
          fileSystem.saveManuscript(projectPath, content),

        loadManuscript: ({ projectPath }) =>
          fileSystem.loadManuscript(projectPath),

        saveBibtex: ({ projectPath, bibtex }) =>
          fileSystem.saveBibtex(projectPath, bibtex),

        loadBibtex: ({ projectPath }) => fileSystem.loadBibtex(projectPath),

        resolveDOI: ({ doi }) => citationClient.resolveDOI(doi),

        searchCitations: ({ query }) => citationClient.searchOpenAlex(query),

        searchKnowledgeBase: async (_params) => {
          // Phase 4: LanceDB RAG pipeline
          return [];
        },

        // Proxy Ollama chat request to avoid CORS issues
        generateTextStream: async ({ model, messages }, sendChunk) => {
          await ollamaClient.streamChat(
            { model, messages },
            (chunk: string) => sendChunk({ content: chunk })
          );
        },
      },
      messages: {
        aiChunk: (payload) => {
          console.log("[Bun] aiChunk message:", payload);
        },
      },
    },
  });

  const _win = new BrowserWindow({
    title: "ScholarPen",
    url,
    rpc: scholarRpc,
    frame: {
      width: 1400,
      height: 900,
      x: 100,
      y: 100,
    },
  });

  console.log("[ScholarPen] App started");
}

main().catch(console.error);

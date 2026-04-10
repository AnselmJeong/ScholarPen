import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils } from "electrobun/bun";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { ollamaClient } from "./ollama/client";
import { claudeClient } from "./claude/client";
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

// Module-level send ref — set after BrowserWindow is created
let sendClaudeChunk: ((payload: { content: string; done: boolean; sessionId?: string; slashCommands?: string[] }) => void) | null = null;

async function main() {
  const url = await getMainViewUrl();

  // ── Application Menu ───────────────────────────────────────────
  ApplicationMenu.setApplicationMenu([
    { label: "ScholarPen", submenu: [{ role: "quit" }] },
    {
      label: "File",
      submenu: [
        { label: "Save", action: "save", accelerator: "s" },
        { type: "separator" },
        { label: "Export as Markdown…", action: "exportMarkdown" },
        { label: "Import Markdown…", action: "importMarkdown" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);

  // ── Define typed RPC ──────────────────────────────────────────
  const scholarRpc = BrowserView.defineRPC<ScholarRPC>({
    maxRequestTime: 30_000,
    handlers: {
      requests: {
        getOllamaStatus: () => ollamaClient.getStatus(),

        listProjects: () => fileSystem.listProjects(),

        openProject: ({ name }) => fileSystem.openProject(name),

        openProjectByPath: ({ projectPath }) => fileSystem.openProjectByPath(projectPath),

        createProject: ({ name }) => fileSystem.createProject(name),

        // ── Document CRUD ─────────────────────────────────
        saveDocument: ({ projectPath, filename, content }) =>
          fileSystem.saveDocument(projectPath, filename, content),

        loadDocument: ({ projectPath, filename }) =>
          fileSystem.loadDocument(projectPath, filename),

        createDocument: ({ projectPath, filename, content }) =>
          fileSystem.createDocument(projectPath, filename, content),

        // ── Legacy ─────────────────────────────────────────
        saveManuscript: ({ projectPath, content }) =>
          fileSystem.saveManuscript(projectPath, content),

        loadManuscript: ({ projectPath }) =>
          fileSystem.loadManuscript(projectPath),

        saveBibtex: ({ projectPath, bibtex }) =>
          fileSystem.saveBibtex(projectPath, bibtex),

        loadBibtex: ({ projectPath }) => fileSystem.loadBibtex(projectPath),

        resolveDOI: ({ doi }) => citationClient.resolveDOI(doi),

        searchCitations: ({ query }) => citationClient.searchOpenAlex(query),

        searchKnowledgeBase: async () => {
          // Phase 4: LanceDB RAG pipeline
          return [];
        },

        listProjectFiles: ({ projectPath }) =>
          fileSystem.listProjectFiles(projectPath),

        openFolderDialog: () => fileSystem.openFolderDialog(),

        // ── Export ─────────────────────────────────────────
        exportFile: ({ projectPath, filename, content }) =>
          fileSystem.exportFile(projectPath, filename, content),

        // ── File Management ────────────────────────────────
        readTextFile: ({ filePath }) => fileSystem.readTextFile(filePath),
        renameFile: ({ filePath, newName }) => fileSystem.renameFile(filePath, newName),
        deleteFile: ({ filePath }) => fileSystem.deleteFile(filePath),

        getSettings: () => fileSystem.getSettings(),

        saveSettings: ({ settings }) => fileSystem.saveSettings(settings),

        // ── Claude CLI streaming ───────────────────────────
        // Fire-and-forget: return immediately so Electrobun can process
        // outbound claudeChunk messages while Claude streams in background.
        claudeStream: ({ message, sessionId, projectPath }) => {
          claudeClient.streamChat(message, sessionId, projectPath, {
            onChunk: (text) => sendClaudeChunk?.({ content: text, done: false }),
            onDone: (newSessionId) =>
              sendClaudeChunk?.({ content: "", done: true, sessionId: newSessionId }),
            onInit: (slashCommands) =>
              sendClaudeChunk?.({ content: "", done: false, slashCommands }),
          }).catch((err) => {
            sendClaudeChunk?.({ content: `\n\n❌ 오류: ${err.message}`, done: false });
            sendClaudeChunk?.({ content: "", done: true });
          });
        },

        // Proxy Ollama chat request to avoid CORS issues
        // Note: generateTextStream uses Electrobun's streaming RPC pattern
        // where the second arg is a sendChunk callback, not a standard request param.
        // @ts-expect-error — Electrobun streaming RPC has a different call signature
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

  // ── Create main window ────────────────────────────────────────
  const win = new BrowserWindow({
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

  // ── Wire up Claude chunk sender ──────────────────────────────
  sendClaudeChunk = (payload) => win.webview.rpc?.send.claudeChunk(payload);

  // ── Menu action events ──────────────────────────────────────
  Electrobun.events.on("application-menu-clicked", (e) => {
    const action = e.data.action;
    if (action === "save" || action === "exportMarkdown" || action === "importMarkdown") {
      win.webview.rpc?.send.menuAction({ action });
    }
  });

  // ── Import Markdown: open file dialog ───────────────────────
  // This is handled via menuAction message to webview, which then
  // triggers the import flow. The file picking is done on Bun side
  // via Utils.openFileDialog when the webview requests it.

  // ── Save before quit ──────────────────────────────────────────
  Electrobun.events.on("before-quit", async () => {
    win.webview.rpc?.send.menuAction({ action: "save" });
    // Give the webview a moment to flush saves
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  console.log("[ScholarPen] App started");
}

main().catch(console.error);
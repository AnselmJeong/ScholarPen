import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils } from "electrobun/bun";
import { readFile } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { basename, extname } from "path";
import { ollamaClient } from "./ollama/client";
import { claudeClient } from "./claude/client";
import { citationClient } from "./citation/client";
import { fileSystem } from "./fs/manager";
import { findKBRoot, getKBEngine, type KBSearchResult } from "./kb/search";
import type { ScholarRPC } from "../shared/scholar-rpc";

// Build KB context string to prepend to the user's message.
// Uses XML-style tags — Claude understands these well and they
// won't be mistaken for CLI option flags (unlike leading "---").
function buildKBContext(results: KBSearchResult[]): string {
  const items = results.map((r, i) => {
    const excerpt = r.excerpt
      ? `\n    ${r.excerpt.replace(/\n+/g, " ").trim().slice(0, 300)}`
      : "";
    return `[${i + 1}] ${r.title || r.docId} (${r.docType})${excerpt}`;
  });
  return [
    "<kb_context>",
    "STRICT RULES — follow exactly:",
    "1. Answer ONLY from the references listed below. Do NOT use Glob, Read, Bash, or any other tools.",
    "2. Cite every claim with an inline marker [1], [2], etc. immediately after the sentence.",
    "3. Do not fabricate content absent from the references.",
    "4. If the references are insufficient, say so — do not search for more.",
    "",
    "References:",
    ...items,
    "</kb_context>",
  ].join("\n");
}

// Append a formatted reference list after Claude's response
function buildReferenceList(results: KBSearchResult[]): string {
  const lines = results.map(
    (r, i) => `${i + 1}. **${r.title || r.docId}** *(${r.docType})*`
  );
  return `\n\n**References (${results.length})**\n${lines.join("\n")}`;
}

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

// Module-level refs — set after BrowserWindow is created
let sendClaudeChunk: ((payload: { content: string; done: boolean; sessionId?: string; slashCommands?: string[] }) => void) | null = null;
let sendProjectUpdated: ((payload: { projectPath: string }) => void) | null = null;

// File watcher state — tracks external changes to project files
let activeProjectWatcher: FSWatcher | null = null;
const recentlySavedFiles = new Set<string>(); // suppress reload for own saves

function watchProjectDir(projectPath: string) {
  activeProjectWatcher?.close();
  activeProjectWatcher = null;
  try {
    activeProjectWatcher = watch(projectPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, "/");
      // Suppress if we just saved this file
      if (recentlySavedFiles.has(norm) || recentlySavedFiles.has(filename)) return;
      if (norm.endsWith(".scholarpen.json") || norm.endsWith(".bib")) {
        sendProjectUpdated?.({ projectPath });
      }
    });
  } catch (err) {
    console.warn("[Watcher] Could not watch project dir:", err);
  }
}

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

        openProject: async ({ name }) => {
          const proj = await fileSystem.openProject(name);
          watchProjectDir(proj.path);
          return proj;
        },

        openProjectByPath: async ({ projectPath }) => {
          const proj = await fileSystem.openProjectByPath(projectPath);
          watchProjectDir(proj.path);
          return proj;
        },

        createProject: async ({ name }) => {
          const proj = await fileSystem.createProject(name);
          watchProjectDir(proj.path);
          return proj;
        },

        // ── Document CRUD ─────────────────────────────────
        saveDocument: async ({ projectPath, filename, content }) => {
          // Suppress file watcher for 1s to avoid reload loop from our own save
          const rel = `documents/${filename}`;
          recentlySavedFiles.add(rel);
          recentlySavedFiles.add(filename);
          setTimeout(() => {
            recentlySavedFiles.delete(rel);
            recentlySavedFiles.delete(filename);
          }, 1000);
          return fileSystem.saveDocument(projectPath, filename, content);
        },

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

        searchCitations: async ({ query }) => {
          const settings = await fileSystem.getSettings();
          return citationClient.searchOpenAlex(query, 10, settings.openAlexApiKey || undefined);
        },

        searchKnowledgeBase: async ({ projectPath, query }) => {
          const kbRoot = await findKBRoot(projectPath);
          if (!kbRoot) return [];
          const engine = getKBEngine(kbRoot);
          await engine.ensureIndexed();
          const results = engine.search(query, 5);
          return results.map((r) => ({
            id: r.docId,
            text: r.excerpt,
            score: r.score,
            metadata: {
              title: r.title,
              authors: r.authors,
              year: r.year,
              sourceFile: r.filePath,
              chunkIndex: 0,
              section: r.docType,
            },
          }));
        },

        getKBStatus: async ({ projectPath }) => {
          const kbRoot = await findKBRoot(projectPath);
          if (!kbRoot) {
            return { exists: false, kbRoot: null, pageCount: 0, lastIndexed: null };
          }
          const engine = getKBEngine(kbRoot);
          // Kick off indexing in background so it's ready for the first query
          engine.ensureIndexed().catch((err) =>
            console.warn("[KB] Background indexing error:", err)
          );
          const { pageCount, lastIndexed } = engine.getStatus();
          return { exists: true, kbRoot, pageCount, lastIndexed };
        },

        rebuildKBIndex: async ({ projectPath }) => {
          const kbRoot = await findKBRoot(projectPath);
          if (!kbRoot) return;
          const engine = getKBEngine(kbRoot);
          await engine.rebuild();
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
        getClaudeSlashCommands: ({ projectPath }) => claudeClient.getSlashCommands(projectPath),

        // Fire-and-forget: return immediately so Electrobun can process
        // outbound claudeChunk messages while Claude streams in background.
        claudeStream: async ({ message, sessionId, projectPath, kbEnabled }) => {
          const settings = await fileSystem.getSettings();
          const model = settings.ollamaDefaultModel || "qwen3.5:cloud";

          let enrichedMessage = message;
          let kbResults: import("./kb/search").KBSearchResult[] = [];

          // Slash commands (e.g. /kb-query, /lit-search) handle their own
          // context via skill definitions and need full tool access (Read, Glob, etc.).
          // Skip KB injection and tool restriction for them.
          const isSlashCommand = message.trimStart().startsWith("/");

          // Inject KB context when enabled and project has a KB
          if (!isSlashCommand && kbEnabled !== false && projectPath) {
            try {
              const kbRoot = await findKBRoot(projectPath);
              if (kbRoot) {
                const engine = getKBEngine(kbRoot);
                await engine.ensureIndexed();
                kbResults = engine.search(message, 5);
                if (kbResults.length > 0) {
                  enrichedMessage = buildKBContext(kbResults) + "\n\n" + message;
                }
              }
            } catch (err) {
              console.warn("[KB] Context injection failed, proceeding without KB:", err);
            }
          }

          const usingKB = !isSlashCommand && kbResults.length > 0;

          claudeClient.streamChat(enrichedMessage, sessionId, projectPath, model, {
            onChunk: (text) => sendClaudeChunk?.({ content: text, done: false }),
            onDone: (newSessionId) => {
              // Append formatted reference list when KB was used
              if (usingKB) {
                sendClaudeChunk?.({ content: buildReferenceList(kbResults), done: false });
              }
              sendClaudeChunk?.({ content: "", done: true, sessionId: newSessionId });
            },
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

  // ── Wire up message senders ──────────────────────────────────
  sendClaudeChunk = (payload) => win.webview.rpc?.send.claudeChunk(payload);
  sendProjectUpdated = (payload) => win.webview.rpc?.send.projectUpdated(payload);

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
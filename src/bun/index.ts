import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils } from "electrobun/bun";
import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { ollamaClient } from "./ollama/client";
import { citationClient } from "./citation/client";
import { fileSystem } from "./fs/manager";
import { findKBRoot, getKBEngine } from "./kb/search";
import { buildKBGraph } from "./kb/graph";
import { listAgentSkills } from "./agent/skill-registry";
import { listAgentMentionableFiles } from "./agent/mention-resolver";
import { streamScholarAgent } from "./agent/service";
import { listProviderModels } from "./agent/providers";
import { getAgentThreadStore } from "./agent/thread-store";
import type { ScholarRPC } from "../shared/scholar-rpc";


function buildSubprocessEnv(): Record<string, string> {
  const currentPath = process.env.PATH ?? "";
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(":"),
    HOME: process.env.HOME ?? "",
  };
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
let sendProjectUpdated: ((payload: { projectPath: string; filePath?: string }) => void) | null = null;
let sendAiChunk: ((payload: { content: string; done: boolean }) => void) | null = null;
let sendAgentChunk: ((payload: { content: string; done: boolean }) => void) | null = null;

// Tracks the in-flight Ollama stream so `abortAiStream` can cancel it.
let activeAiAbortController: AbortController | null = null;
let activeAgentAbortController: AbortController | null = null;

function openValidatedExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid external URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https external links are allowed.");
  }

  Utils.openExternal(parsed.toString());
}

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
        sendProjectUpdated?.({ projectPath, filePath: join(projectPath, norm) });
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
    { label: "ScholarPen", submenu: [{ label: "Quit ScholarPen", action: "quit", accelerator: "q" }] },
    {
      label: "File",
      submenu: [
        { label: "New Document", action: "newDocument", accelerator: "n" },
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
          // Suppress file watcher for 3s to avoid reload loop from our own save
          const rel = `documents/${filename}`;
          recentlySavedFiles.add(rel);
          recentlySavedFiles.add(filename);
          setTimeout(() => {
            recentlySavedFiles.delete(rel);
            recentlySavedFiles.delete(filename);
          }, 3000);
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

        saveBibtex: async ({ projectPath, bibtex }) => {
          // Suppress file watcher to avoid triggering a document reload
          recentlySavedFiles.add("references.bib");
          setTimeout(() => recentlySavedFiles.delete("references.bib"), 3000);
          await fileSystem.saveBibtex(projectPath, bibtex);
          sendProjectUpdated?.({ projectPath, filePath: join(projectPath, "references.bib") });
        },

        saveBibtexRaw: async ({ projectPath, bibtex }) => {
          recentlySavedFiles.add("references.bib");
          setTimeout(() => recentlySavedFiles.delete("references.bib"), 3000);
          await fileSystem.saveBibtexRaw(projectPath, bibtex);
          sendProjectUpdated?.({ projectPath, filePath: join(projectPath, "references.bib") });
        },

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
          const settings = await fileSystem.getSettings();
          const results = engine.search(query, settings.kbTopK || 5);
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

        getKBGraph: ({ projectPath }) => buildKBGraph(projectPath),

        listProjectFiles: ({ projectPath }) =>
          fileSystem.listProjectFiles(projectPath),

        openFolderDialog: () => fileSystem.openFolderDialog(),

        // ── Export ─────────────────────────────────────────
        exportFile: ({ projectPath, filename, content }) =>
          fileSystem.exportFile(projectPath, filename, content),

        // ── File Management ────────────────────────────────
        readTextFile: ({ filePath }) => fileSystem.readTextFile(filePath),
        readBinaryFile: ({ filePath }) => fileSystem.readBinaryFile(filePath),
        renameFile: ({ filePath, newName }) => fileSystem.renameFile(filePath, newName),
        deleteFile: ({ filePath }) => fileSystem.deleteFile(filePath),

        getSettings: () => fileSystem.getSettings(),

        saveSettings: ({ settings }) => fileSystem.saveSettings(settings),

        // ── Ollama model list ──────────────────────────────
        getOllamaModels: async () => {
          try {
            const proc = Bun.spawn(["ollama", "list"], { stdout: "pipe", stderr: "pipe", env: buildSubprocessEnv() });
            const text = await new Response(proc.stdout).text();
            await proc.exited;
            // Parse: skip header line, extract first column (NAME)
            return text
              .split("\n")
              .slice(1)
              .map((line) => line.split(/\s+/)[0])
              .filter(Boolean);
          } catch {
            return [];
          }
        },

        listProviderModels: async ({ provider, settings }) => {
          const saved = await fileSystem.getSettings();
          return listProviderModels(provider, { ...saved, ...(settings ?? {}) });
        },

        listAgentSkills: ({ projectPath }) => listAgentSkills(projectPath),

        listAgentMentionableFiles: ({ projectPath }) => listAgentMentionableFiles(projectPath),

        listAgentThreads: async ({ projectPath }) => {
          const store = await getAgentThreadStore(projectPath);
          return store.listThreads();
        },

        createAgentThread: async ({ projectPath, provider, model, title, metadata }) => {
          const store = await getAgentThreadStore(projectPath);
          return store.createThread({ provider, model, title, metadata });
        },

        getAgentThread: async ({ projectPath, threadId }) => {
          const store = await getAgentThreadStore(projectPath);
          return store.getThread(threadId);
        },

        deleteAgentThread: async ({ projectPath, threadId }) => {
          const store = await getAgentThreadStore(projectPath);
          store.deleteThread(threadId);
        },

        saveAgentThreadMessage: async ({ projectPath, threadId, role, content, status, metadata }) => {
          const store = await getAgentThreadStore(projectPath);
          return store.saveMessage({ threadId, role, content, status, metadata });
        },

        agentStream: async (params) => {
          activeAgentAbortController?.abort();
          const controller = new AbortController();
          activeAgentAbortController = controller;

          streamScholarAgent(
            params,
            {
              onChunk: (text) => sendAgentChunk?.({ content: text, done: false }),
              onDone: () => sendAgentChunk?.({ content: "", done: true }),
              onError: (message) => {
                sendAgentChunk?.({ content: `\n\n❌ ${message}`, done: false });
                sendAgentChunk?.({ content: "", done: true });
              },
            },
            controller.signal,
          ).finally(() => {
            if (activeAgentAbortController === controller) {
              activeAgentAbortController = null;
            }
          });
        },

        abortAgentStream: () => {
          activeAgentAbortController?.abort();
        },

        openExternal: ({ url }) => { openValidatedExternalUrl(url); },

        // Proxy Ollama chat to the renderer via aiChunk messages.
        // Fire-and-forget: return immediately so Electrobun can flush outbound
        // aiChunk messages while the stream runs in the background.
        generateTextStream: async ({ model, messages, think }) => {
          activeAiAbortController?.abort();
          const controller = new AbortController();
          activeAiAbortController = controller;

          ollamaClient
            .streamChat(
              { model, messages, think },
              (chunk) => sendAiChunk?.({ content: chunk, done: false }),
              controller.signal
            )
            .then(() => sendAiChunk?.({ content: "", done: true }))
            .catch((err: Error) => {
              if (err.name === "AbortError") {
                sendAiChunk?.({ content: "", done: true });
                return;
              }
              sendAiChunk?.({ content: `\n\n❌ ${err.message}`, done: false });
              sendAiChunk?.({ content: "", done: true });
            })
            .finally(() => {
              if (activeAiAbortController === controller) {
                activeAiAbortController = null;
              }
            });
        },

        abortAiStream: () => {
          activeAiAbortController?.abort();
        },
      },
      messages: {
        aiChunk: (payload) => {
          console.log("[Bun] aiChunk message:", payload);
        },
        agentChunk: (payload) => {
          console.log("[Bun] agentChunk message:", payload);
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
  sendProjectUpdated = (payload) => win.webview.rpc?.send.projectUpdated(payload);
  sendAiChunk = (payload) => win.webview.rpc?.send.aiChunk(payload);
  sendAgentChunk = (payload) => win.webview.rpc?.send.agentChunk(payload);

  // ── Menu action events ──────────────────────────────────────
  Electrobun.events.on("application-menu-clicked", (e) => {
    const action = e.data.action;
    if (action === "save" || action === "newDocument" || action === "exportMarkdown" || action === "importMarkdown") {
      win.webview.rpc?.send.menuAction({ action });
    } else if (action === "quit") {
      // Save first, then quit after a brief flush window
      win.webview.rpc?.send.menuAction({ action: "save" });
      setTimeout(() => Utils.quit(), 400);
    }
  });

  console.log("[ScholarPen] App started");
}

main().catch(console.error);

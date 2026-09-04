import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils } from "electrobun/bun";
import { watch, type FSWatcher } from "fs";
import { join } from "path";
import packageJson from "../../package.json";
import { ollamaClient } from "./ollama/client";
import { citationClient } from "./citation/client";
import { BIBLIOGRAPHY_RELATIVE_PATH, fileSystem } from "./fs/manager";
import { listAgentSkills } from "./agent/skill-registry";
import { listAgentMentionableFiles } from "./agent/mention-resolver";
import { streamScholarAgent } from "./agent/service";
import { listProviderModels } from "./agent/providers";
import { getAgentThreadStore } from "./agent/thread-store";
import { getProjectSourceIndex, isProjectSourceDigestPath } from "./project-sources";
import { openOllamaChatCompletion, pipeResponseText } from "./ollama/openai-proxy";
import { cleanValidateAndApplyBibliography } from "./citation/bibliography-maintenance";
import { renderQuartoBookProject } from "./quarto/render";
import {
  proposeBibliographyRepair,
  validateBibliographyRepair,
} from "./citation/bibliography-repair";
import type { BibliographyValidationProgress } from "../shared/rpc-types";
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
let sendOllamaProxyChunk: ((payload: { requestId: string; content: string; done: boolean; error?: string }) => void) | null = null;
let sendBibliographyValidationProgress: ((payload: BibliographyValidationProgress) => void) | null = null;

// Tracks the in-flight Ollama stream so `abortAiStream` can cancel it.
let activeAiAbortController: AbortController | null = null;
let activeAgentAbortController: AbortController | null = null;
const activeOllamaProxyControllers = new Map<string, AbortController>();

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
const internallyUpdatingProjects = new Set<string>();

function watchProjectDir(projectPath: string) {
  activeProjectWatcher?.close();
  activeProjectWatcher = null;
  try {
    activeProjectWatcher = watch(projectPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, "/");
      // Suppress if we just saved this file
      if (internallyUpdatingProjects.has(projectPath)) return;
      if (recentlySavedFiles.has(norm) || recentlySavedFiles.has(filename)) return;
      if (norm.endsWith(".scholarpen.json") || norm.endsWith(".bib")) {
        sendProjectUpdated?.({ projectPath, filePath: join(projectPath, norm) });
      }
      const lower = norm.toLowerCase();
      if (isProjectSourceDigestPath(projectPath, norm) ||
          (lower.startsWith("resources/articles/") && lower.endsWith(".pdf"))) {
        getProjectSourceIndex(projectPath).markDirty();
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
    {
      label: "ScholarPen",
      submenu: [
        { label: "About ScholarPen", action: "aboutScholarPen" },
        { type: "separator" },
        { label: "Quit ScholarPen", action: "quit", accelerator: "q" },
      ],
    },
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
        { type: "separator" },
        { label: "Find & Replace in Documents…", action: "findReplaceDocuments" },
      ],
    },
  ]);

  // ── Define typed RPC ──────────────────────────────────────────
  const scholarRpc = BrowserView.defineRPC<ScholarRPC>({
    maxRequestTime: 600_000,
    handlers: {
      requests: {
        getOllamaStatus: () => ollamaClient.getStatus(),

        confirmAction: async ({
          title,
          message,
          detail = "",
          confirmLabel = "확인",
        }) => {
          const { response } = await Utils.showMessageBox({
            type: "question",
            title,
            message,
            detail,
            buttons: [confirmLabel, "취소"],
            defaultId: 1,
            cancelId: 1,
          });
          return response === 0;
        },

        listProjects: () => fileSystem.listProjects(),

        openProject: async ({ name }) => {
          const proj = await fileSystem.openProject(name);
          watchProjectDir(proj.path);
          void getProjectSourceIndex(proj.path).ensureFresh().catch((error) => {
            console.warn("[ProjectSources] Initial indexing failed:", error);
          });
          return proj;
        },

        openProjectByPath: async ({ projectPath }) => {
          const proj = await fileSystem.openProjectByPath(projectPath);
          watchProjectDir(proj.path);
          void getProjectSourceIndex(proj.path).ensureFresh().catch((error) => {
            console.warn("[ProjectSources] Initial indexing failed:", error);
          });
          return proj;
        },

        createProject: async ({ name }) => {
          const proj = await fileSystem.createProject(name);
          watchProjectDir(proj.path);
          void getProjectSourceIndex(proj.path).ensureFresh().catch((error) => {
            console.warn("[ProjectSources] Initial indexing failed:", error);
          });
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

        saveDocuments: async ({ projectPath, documents }) => {
          for (const { filename } of documents) {
            recentlySavedFiles.add(`documents/${filename}`);
            recentlySavedFiles.add(filename);
          }
          setTimeout(() => {
            for (const { filename } of documents) {
              recentlySavedFiles.delete(`documents/${filename}`);
              recentlySavedFiles.delete(filename);
            }
          }, 3000);
          await fileSystem.saveDocuments(projectPath, documents);
          sendProjectUpdated?.({ projectPath });
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
          recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
          recentlySavedFiles.add("references.bib");
          setTimeout(() => {
            recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.delete("references.bib");
          }, 3000);
          await fileSystem.saveBibtex(projectPath, bibtex);
          sendProjectUpdated?.({
            projectPath,
            filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
          });
        },

        saveBibtexRaw: async ({ projectPath, bibtex }) => {
          recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
          recentlySavedFiles.add("references.bib");
          setTimeout(() => {
            recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.delete("references.bib");
          }, 3000);
          await fileSystem.saveBibtexRaw(projectPath, bibtex);
          sendProjectUpdated?.({
            projectPath,
            filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
          });
        },

        saveBibtexValidated: async ({ projectPath, bibtex, expectedCurrentBibtex }) => {
          recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
          recentlySavedFiles.add("references.bib");
          setTimeout(() => {
            recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.delete("references.bib");
          }, 3000);
          await fileSystem.saveBibtexValidated(projectPath, bibtex, expectedCurrentBibtex);
          sendProjectUpdated?.({
            projectPath,
            filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
          });
        },

        loadBibtex: ({ projectPath }) => fileSystem.loadBibtex(projectPath),

        mergeBibtex: async ({ projectPath, importedBibtex }) => {
          internallyUpdatingProjects.add(projectPath);
          try {
            const result = await fileSystem.mergeBibtex(projectPath, importedBibtex);
            if (result.addedEntries > 0) {
              sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
              });
            }
            return result;
          } finally {
            setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
          }
        },

        proposeBibliographyRepair: async ({ projectPath, bibtex, mode }) => {
          await fileSystem.loadBibtex(projectPath);
          const settings = await fileSystem.getSettings();
          return proposeBibliographyRepair(bibtex, mode, settings);
        },

        applyBibliographyRepair: async ({ projectPath, originalBibtex, repairedBibtex }) => {
          validateBibliographyRepair(originalBibtex, repairedBibtex);
          internallyUpdatingProjects.add(projectPath);
          try {
            const backupPath = await fileSystem.saveBibliographyMaintenance(
              projectPath,
              repairedBibtex,
              "bibliography-syntax-repair",
              originalBibtex,
            );
            sendProjectUpdated?.({
              projectPath,
              filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
            });
            return backupPath;
          } finally {
            setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
          }
        },

        deduplicateBibliography: async ({ projectPath, bibtex }) => {
          internallyUpdatingProjects.add(projectPath);
          try {
            const result = await fileSystem.deduplicateBibliography(projectPath, bibtex);
            if (result.removedEntries > 0) {
              sendProjectUpdated?.({ projectPath });
              sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
              });
            }
            return result;
          } finally {
            setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
          }
        },

        validateAndCleanBibliography: async ({ projectPath, bibtex }) => {
          internallyUpdatingProjects.add(projectPath);
          try {
            const result = await cleanValidateAndApplyBibliography({
              projectPath,
              bibtex,
              fileSystem,
              onProgress: (progress) => sendBibliographyValidationProgress?.(progress),
            });
            if (result.backupPath) {
              sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
              });
            }
            return result;
          } finally {
            setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
          }
        },

        resolveDOI: ({ doi }) => citationClient.resolveDOI(doi),

        searchCitations: async ({ query }) => {
          const settings = await fileSystem.getSettings();
          return citationClient.searchOpenAlex(query, 10, settings.openAlexApiKey || undefined);
        },

        listProjectFiles: ({ projectPath }) =>
          fileSystem.listProjectFiles(projectPath),

        openFolderDialog: () => fileSystem.openFolderDialog(),

        // ── Export ─────────────────────────────────────────
        exportFile: ({ projectPath, filename, content }) =>
          fileSystem.exportFile(projectPath, filename, content),

        renderQuartoBook: async ({ projectPath, format }) => {
          const result = await renderQuartoBookProject({
            projectDirectory: await fileSystem.getQuartoProjectDirectory(projectPath),
            format,
            environment: buildSubprocessEnv(),
          });
          if (result.status === "success") sendProjectUpdated?.({ projectPath });
          return result;
        },

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

        getProjectSourcesStatus: ({ projectPath }) => getProjectSourceIndex(projectPath).status(),

        rebuildProjectSourcesIndex: ({ projectPath }) => {
          const index = getProjectSourceIndex(projectPath);
          index.markDirty();
          return index.status(true);
        },

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

        startOllamaOpenAIProxy: async ({ requestId, body }) => {
          activeOllamaProxyControllers.get(requestId)?.abort();
          const controller = new AbortController();
          activeOllamaProxyControllers.set(requestId, controller);

          try {
            const response = await openOllamaChatCompletion(body, controller.signal);
            void pipeResponseText(response, (content) => {
              sendOllamaProxyChunk?.({ requestId, content, done: false });
            })
              .then(() => sendOllamaProxyChunk?.({ requestId, content: "", done: true }))
              .catch((error: Error) => {
                if (error.name === "AbortError") {
                  sendOllamaProxyChunk?.({ requestId, content: "", done: true });
                  return;
                }
                sendOllamaProxyChunk?.({
                  requestId,
                  content: "",
                  done: true,
                  error: error.message,
                });
              })
              .finally(() => {
                if (activeOllamaProxyControllers.get(requestId) === controller) {
                  activeOllamaProxyControllers.delete(requestId);
                }
              });

            return {
              status: response.status,
              statusText: response.statusText,
              contentType: response.headers.get("content-type") ?? "text/event-stream",
            };
          } catch (error) {
            if (activeOllamaProxyControllers.get(requestId) === controller) {
              activeOllamaProxyControllers.delete(requestId);
            }
            throw error;
          }
        },

        abortOllamaOpenAIProxy: ({ requestId }) => {
          activeOllamaProxyControllers.get(requestId)?.abort();
        },
      },
      messages: {
        aiChunk: (payload) => {
          console.log("[Bun] aiChunk message:", payload);
        },
        agentChunk: (payload) => {
          console.log("[Bun] agentChunk message:", payload);
        },
        bibliographyValidationProgress: (payload) => {
          console.log("[Bun] bibliography validation progress:", payload);
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
  sendOllamaProxyChunk = (payload) => win.webview.rpc?.send.ollamaProxyChunk(payload);
  sendBibliographyValidationProgress = (payload) =>
    win.webview.rpc?.send.bibliographyValidationProgress(payload);

  // ── Menu action events ──────────────────────────────────────
  Electrobun.events.on("application-menu-clicked", (e) => {
    const action = e.data.action;
    if (action === "aboutScholarPen") {
      win.webview.rpc?.send.menuAction({ action });
    } else if (action === "save" || action === "newDocument" || action === "exportMarkdown" || action === "importMarkdown") {
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

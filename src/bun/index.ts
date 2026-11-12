import { writingPreferences, preparePunctuationMessages } from "./ai/writing-preferences";
import { detectStyleLanguage } from "../shared/author-style";
import { readDoc } from "./collab/agent/doc-model";
import { initializeExtensions, shutdownExtensions } from "./extensions/runtime";
import { createLegacyExtensionHandlers } from "./extensions/catalog.generated";
import { exportReviewManuscripts } from "./review/manuscript-export";
import { reviewEngine, reviewView, decideFigure, importFigure, reviewFigurePreview, exportReview, reviewManuscript, reviewRevisionContext, reviewSaveRevisionResponse, exportReviewResponses } from "./review/service";
import { claudeClient } from "./claude/client";
import * as Y from "yjs";
import { toBase64 } from "lib0/buffer";
import { ProjectReviewSettingsStore, applyProjectReviewSettings } from "./collab/project-review-settings";
import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils, Updater } from "electrobun/bun";
import { watch, type FSWatcher } from "fs";
import { join } from "path";
import packageJson from "../../package.json";
import { ollamaClient } from "./ollama/client";
import { BIBLIOGRAPHY_RELATIVE_PATH, fileSystem } from "./fs/manager";
import { listAgentSkills } from "./agent/skill-registry";
import { listAgentMentionableFiles } from "./agent/mention-resolver";
import { streamScholarAgent } from "./agent/service";
import { projectMemorySync } from "./memory/runtime";
import { authorStyleScheduler } from "./extensions/author-style";
import { composeWritingContext, styleContext } from "./ai/context-composer";
import { createExtensionServices } from "./extensions/services";
import { listProviderModels } from "./agent/providers";
import { codexClient } from "./codex/client";
import { getAgentThreadStore } from "./agent/thread-store";
import { getProjectSourceIndex, isProjectSourceDigestPath } from "./project-sources";
import { getCitationSourceIndex, isCitationSourcePdfPath } from "./citation-check/source-index";
import { citationPdfCoverage } from "./citation-check/coverage";
import { openOllamaChatCompletion, pipeResponseText } from "./ollama/openai-proxy";
import type { BibliographyValidationProgress } from "../shared/rpc-types";
import type { ScholarRPC } from "../shared/scholar-rpc";
import { figureMimeType } from "../shared/figure-files";
import type { CollabUpdateMessage } from "../shared/collab/protocol";
import { CollabRegistry } from "./collab/registry";
import { manuscriptFingerprint } from "../shared/collab/content-fingerprint";
import { collabDocKey } from "../shared/collab/protocol";
import { createFileCollabStorage } from "./collab/storage";
import { CollabAgent } from "./collab/agent/agent";
import { CollabHistory } from "./collab/history/history";
import { createFileHistoryStorage } from "./collab/history/store";
import { Reviewer } from "./collab/agent/reviewer";
import { ProjectWriting } from "./collab/project-writing";
import { enqueueDraft, zoneEditMode } from "./collab/agent/zones";
import { parseBibtexCitekeys } from "../shared/bibtex-utils";
import { completeAgentModel } from "./agent/providers";
import type { AgentActivityMessage } from "../shared/collab/agent-types";

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
  if (await Updater.localInfo.channel() !== "dev") return "views://mainview/index.html";
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
let sendCollabUpdate: ((payload: CollabUpdateMessage) => void) | null = null;
let sendCollabAwareness: ((payload: CollabUpdateMessage) => void) | null = null;

// Shared Y.Doc per open document. Editors and the AI agent are peers of it.
const collabRegistry = new CollabRegistry(createFileCollabStorage(fileSystem), {
  update: (message) => sendCollabUpdate?.(message),
  awareness: (message) => sendCollabAwareness?.(message),
});
const projectReviewSettings = new ProjectReviewSettingsStore();
let sendCollabActivity: ((payload: AgentActivityMessage) => void) | null = null;

async function completeWithSettings(messages: Parameters<typeof completeAgentModel>[0]["messages"], signal: AbortSignal, maxTokens = 4096) {
  const settings = await fileSystem.getSettings();
  return completeAgentModel({
    provider: settings.sidebarAgentProvider,
    model: settings.sidebarAgentModel,
    messages,
    maxTokens,
    temperature: 0.2,
    signal,
  }, settings);
}

// Project-wide writing support: glossary, manuscript map and consistency check.
const projectWriting = new ProjectWriting(collabRegistry, {
  complete: (messages, signal, maxTokens) => completeWithSettings(messages, signal, maxTokens),
});

// The AI co-author: a Bun-side peer that answers comment threads with edits…
const collabAgent = new CollabAgent(collabRegistry, {
  projectGuide: async (session, purpose = "rewrite") => ({ ...await projectWriting.guide(session.projectPath),
    preferences: (await styleContext(session.projectPath, { purpose, language: detectStyleLanguage(readDoc(session).textContent), model: (await fileSystem.getSettings()).sidebarAgentModel })).text }),
  complete: completeWithSettings,
  completeBulk: (messages, signal) => completeWithSettings(messages, signal, 16384),
  onActivity: (docKey) => sendCollabActivity?.(collabAgentStatus(docKey)),
  // Each section's work zone decides whether AI edits are proposals, suggestions or direct.
  editModeFor: zoneEditMode,
});
// …and reviews the whole manuscript, independently of the author’s edits.
const collabReviewer = new Reviewer(collabAgent, {
  complete: (messages, signal) => completeWithSettings(messages, signal, 8192),
  glossary: (projectPath) => projectWriting.guide(projectPath).then((guide) => guide.glossary),
  citekeys: async (projectPath) => {
    const bibtex = await fileSystem.loadBibtex(projectPath).catch(() => "");
    return bibtex.trim() ? new Set(parseBibtexCitekeys(bibtex)) : null;
  },
});

// Version history: every change to an open document, grouped into checkpoints.
let sendCollabHistoryChanged: ((payload: { docKey: string }) => void) | null = null;
const collabHistory = new CollabHistory(collabRegistry, createFileHistoryStorage(fileSystem), {
  aiLabel: (docKey) => collabAgent.jobs(docKey).find((job) => job.state === "working")?.label,
  aiBusy: (docKey) => collabAgent.jobs(docKey).some((job) => job.state === "working"),
  onChanged: (docKey) => sendCollabHistoryChanged?.({ docKey }),
});

function collabAgentStatus(docKey: string): AgentActivityMessage {
  return {
    docKey,
    jobs: collabAgent.jobs(docKey),
    paused: collabAgent.isPaused(),
    canUndo: collabAgent.canUndo(docKey),
  };
}

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
  projectMemorySync.start(projectPath);
  authorStyleScheduler.start(projectPath);
  // Extract and index cited PDFs in the background, after the project has opened.
  getCitationSourceIndex(projectPath).scheduleScan(3_000);
  activeProjectWatcher?.close();
  activeProjectWatcher = null;
  try {
    activeProjectWatcher = watch(projectPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, "/");
      if (norm === "reviews" || norm.startsWith("reviews/")) return;
      if (figureMimeType(norm)) {
        sendProjectUpdated?.({ projectPath, filePath: join(projectPath, norm) });
        return;
      }
      // Suppress if we just saved this file
      if (internallyUpdatingProjects.has(projectPath)) return;
      if (recentlySavedFiles.has(norm) || recentlySavedFiles.has(filename)) return;
      if (norm.endsWith(".scholarpen.json") || norm.endsWith(".bib")) {
        sendProjectUpdated?.({ projectPath, filePath: join(projectPath, norm) });
      }
      const lower = norm.toLowerCase();
      if (isCitationSourcePdfPath(norm)) getCitationSourceIndex(projectPath).scheduleScan();
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
  const extensions = await initializeExtensions(createExtensionServices({ fileSystem, recentlySavedFiles, internallyUpdatingProjects,
    sendProjectUpdated: payload => sendProjectUpdated?.(payload),
    sendBibliographyValidationProgress: payload => sendBibliographyValidationProgress?.(payload),
    buildSubprocessEnv }));
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
        ...createLegacyExtensionHandlers(extensions),
        extensionsList: () => extensions.list(),
        extensionsInvoke: request => extensions.invoke(request),
        extensionsSetEnabled: request => extensions.setEnabled(request.id, request.enabled),
        extensionsCancel: ({ requestId }) => extensions.cancel(requestId),
        reviewExportManuscripts: async (request) => exportReviewManuscripts((await reviewEngine(request.projectPath)).store, request),
        reviewManuscript,
        reviewRevisionContext,
        reviewSaveRevisionResponse,
        reviewList: async ({ projectPath }) => { const engine = await reviewEngine(projectPath); return Promise.all((await engine.store.list()).map(s => engine.recover(s.id))); },
        reviewConfirmSnapshot: async ({ projectPath, filename, savedDocument, fingerprint }) => {
          const session = collabRegistry.get(collabDocKey(projectPath, filename));
          if (!session) throw new Error(`${filename}: 원고 연결이 닫혔습니다. 다시 시도해 주세요.`);
          const before = await fileSystem.documentJsonHash(projectPath, filename);
          const saved = await fileSystem.loadDocument(projectPath, filename);
          const after = await fileSystem.documentJsonHash(projectPath, filename);
          if (!before || before !== after || JSON.stringify(saved) !== JSON.stringify(savedDocument) || manuscriptFingerprint(session.ydoc) !== fingerprint) {
            throw new Error(`${filename}: 확인 중 원고가 변경됐습니다. 저장 후 다시 시도해 주세요.`);
          }
          await collabRegistry.noteJsonSaved(projectPath, filename, before);
        },
        reviewCreate: async (input) => {
          await collabRegistry.flush();
          for (const session of collabRegistry.list()) {
            if (session.projectPath === input.projectPath && input.documents.includes(session.filename) && /<(?:insertion|deletion|modification)(?:\s|>)/.test(session.ydoc.getXmlFragment("document-store").toString())) {
              throw new Error("미결정 변경 제안을 수락 또는 거절한 뒤 리뷰를 시작해 주세요.");
            }
          }
          const engine = await reviewEngine(input.projectPath);
          return engine.create({ ...input, projectPath: engine.store.project });
        },
        reviewFollowup: async ({ projectPath, sessionId }) => (await reviewEngine(projectPath)).followup(sessionId),
        reviewStart: async ({ projectPath, sessionId }) => (await reviewEngine(projectPath)).start(sessionId),
        reviewGet: reviewView,
        reviewStop: async ({ projectPath, sessionId, cancel }) => (await reviewEngine(projectPath)).stop(sessionId, cancel),
        reviewDecideFigure: decideFigure,
        reviewImportFigure: async (address) => {
          const files = await Utils.openFileDialog({ allowedFileTypes: "png,jpg,jpeg,webp,gif", canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false });
          const path = files.join(",");
          return path ? importFigure(address, path) : null;
        },
        reviewFigurePreview,
        reviewExport: exportReview,
        reviewExportResponses: exportReviewResponses,

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
        getProjectMemoryStatus: ({ projectPath }) => fileSystem.getProjectMemoryStatus(projectPath),

        retainProjectMemory: ({ projectPath, content, source }) => fileSystem.retainProjectMemory(projectPath, content, source),
        recallProjectMemory: ({ projectPath, query }) => fileSystem.recallProjectMemory(projectPath, query),
        getProjectMemoryOperation: ({ projectPath, operationId }) => fileSystem.getProjectMemoryOperation(projectPath, operationId),

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
        saveDocument: async ({ projectPath, filename, content, collab }) => {
          // Suppress file watcher for 3s to avoid reload loop from our own save
          const rel = `documents/${filename}`;
          recentlySavedFiles.add(rel);
          recentlySavedFiles.add(filename);
          setTimeout(() => {
            recentlySavedFiles.delete(rel);
            recentlySavedFiles.delete(filename);
          }, 3000);
          const hash = await fileSystem.saveDocument(projectPath, filename, content);
          if (collab) await collabRegistry.noteJsonSaved(projectPath, filename, hash);
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

        listProjectReferences: ({ projectPath }) => fileSystem.listProjectReferences(projectPath),

        createDocument: ({ projectPath, filename, content }) =>
          fileSystem.createDocument(projectPath, filename, content),

        // ── Legacy ─────────────────────────────────────────
        saveManuscript: ({ projectPath, content }) =>
          fileSystem.saveManuscript(projectPath, content),

        loadManuscript: ({ projectPath }) =>
          fileSystem.loadManuscript(projectPath),

        listProjectFiles: ({ projectPath }) =>
          fileSystem.listProjectFiles(projectPath),

        openFolderDialog: () => fileSystem.openFolderDialog(),

        // ── Export ─────────────────────────────────────────

        exportFile: ({ projectPath, filename, content }) =>
          fileSystem.exportFile(projectPath, filename, content),
        exportBinaryFile: ({ projectPath, filename, base64 }) =>
          fileSystem.exportBinaryFile(projectPath, filename, base64),

        // ── File Management ────────────────────────────────
        readTextFile: ({ filePath }) => fileSystem.readTextFile(filePath),
        readBinaryFile: ({ filePath }) => fileSystem.readBinaryFile(filePath),
        selectFigure: ({ projectPath }) => fileSystem.selectFigure(projectPath),
        readFigure: ({ projectPath, sourcePath }) => fileSystem.readFigure(projectPath, sourcePath),
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

        getCitationSourcesStatus: async ({ projectPath, includeCoverage }) => {
          const path = await fileSystem.resolveProjectPath(projectPath);
          const index = getCitationSourceIndex(path);
          const status = await index.status();
          if (!includeCoverage) return status;
          return { ...status, coverage: await citationPdfCoverage(path) };
        },

        rescanCitationSources: async ({ projectPath }) => {
          const index = getCitationSourceIndex(await fileSystem.resolveProjectPath(projectPath));
          void index.scan().catch((error) => console.warn("[CitationSources] PDF indexing failed:", error));
          return index.status();
        },

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

        getClaudeStatus: () => claudeClient.status(),
        loginClaude: () => claudeClient.login(),
        cancelClaudeLogin: () => claudeClient.cancelLogin(),
        logoutClaude: () => claudeClient.logout(),
        getCodexStatus: (params) => params?.reconnect ? codexClient.refresh() : codexClient.status(),
        loginCodex: async () => { openValidatedExternalUrl(await codexClient.login()); },
        cancelCodexLogin: () => codexClient.cancelLogin(),
        logoutCodex: () => codexClient.logout(),
        openExternal: ({ url }) => { openValidatedExternalUrl(url); },

        collabOpen: async (params) => {
          const opened = await collabRegistry.open(params);
          try {
            const settings = await projectReviewSettings.get(params.projectPath);
            applyProjectReviewSettings(collabRegistry.list(), params.projectPath, settings);
            const session = collabRegistry.get(opened.docKey)!;
            return { ...opened, state: toBase64(Y.encodeStateAsUpdate(session.ydoc)) };
          } catch (error) {
            await collabRegistry.close(opened.docKey, params.peerId);
            throw error;
          }
        },
        collabSetReviewCategory: async ({ docKey, category, enabled }) => {
          const session = collabRegistry.get(docKey);
          if (!session) throw new Error("This document is not open.");
          await projectReviewSettings.setCategory(session.projectPath, category, enabled);
          // Read after pending writes, so simultaneous toggles always broadcast the latest policy.
          const settings = await projectReviewSettings.get(session.projectPath);
          applyProjectReviewSettings(collabRegistry.list(), session.projectPath, settings);
          return settings;
        },
        collabPush: ({ docKey, peerId, update }) => collabRegistry.push(docKey, peerId, update),
        collabAwareness: ({ docKey, peerId, update }) => collabRegistry.pushAwareness(docKey, peerId, update),
        collabClose: ({ docKey, peerId }) => collabRegistry.close(docKey, peerId),
        collabAgentStatus: ({ docKey }) => collabAgentStatus(docKey),
        collabUndoAI: ({ docKey }) => {
          const undone = collabAgent.undoLast(docKey);
          sendCollabActivity?.(collabAgentStatus(docKey));
          return undone;
        },
        collabReviewSection: ({ docKey, blockId }) => {
          collabReviewer.reviewSection(docKey, blockId, "manual");
        },
        getGlossary: ({ projectPath }) => projectWriting.getGlossary(projectPath),
        saveGlossary: ({ projectPath, glossary }) => projectWriting.saveGlossary(projectPath, glossary),
        getManuscriptMap: ({ projectPath }) => projectWriting.mapView(projectPath),
        updateManuscriptMap: ({ projectPath }) => projectWriting.updateMap(projectPath),
        getConsistencyReport: ({ projectPath }) => projectWriting.consistencyView(projectPath),
        runConsistencyCheck: ({ projectPath }) => projectWriting.runConsistency(projectPath),
        collabDraftSection: ({ docKey, blockId }) => {
          enqueueDraft(collabAgent, docKey, blockId, completeWithSettings);
        },
        collabHistoryList: ({ docKey }) => collabHistory.list(docKey),
        collabHistoryVersion: ({ docKey, entryId }) => collabHistory.version(docKey, entryId),
        collabHistoryCheckpoint: ({ docKey, kind, label }) => collabHistory.checkpoint(docKey, { kind, label }),
        collabHistoryName: ({ docKey, entryId, name }) => collabHistory.name(docKey, entryId, name),
        collabSetAgentPaused: ({ paused }) => {
          collabAgent.setPaused(paused);
          for (const session of collabRegistry.list()) sendCollabActivity?.(collabAgentStatus(session.docKey));
        },

        // Proxy Ollama chat to the renderer via aiChunk messages.
        // Fire-and-forget: return immediately so Electrobun can flush outbound
        // aiChunk messages while the stream runs in the background.
        readBibliography: ({ projectPath }) => fileSystem.loadBibtex(projectPath),
        getWritingPreferences: () => writingPreferences.read(),
        saveWritingPreferences: ({ expectedRevision, punctuation }) => writingPreferences.save(expectedRevision, punctuation),
        generateTextStream: async ({ model, messages, think, projectPath, punctuation }) => {
          messages = await composeWritingContext(messages, projectPath ? await fileSystem.resolveProjectPath(projectPath) : undefined, { purpose: "rewrite", model, punctuation });
          messages = await preparePunctuationMessages(messages);
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

        startOllamaOpenAIProxy: async ({ requestId, body, projectPath }) => {
          {
            const request = JSON.parse(body);
            if (Array.isArray(request.messages)) request.messages = await composeWritingContext(request.messages,
              projectPath ? await fileSystem.resolveProjectPath(projectPath) : undefined, { purpose: "rewrite", model: request.model });
            if (Array.isArray(request.messages)) request.messages = await preparePunctuationMessages(request.messages);
            body = JSON.stringify(request);
          }
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
  sendCollabUpdate = (payload) => win.webview.rpc?.send.collabUpdate(payload);
  sendCollabAwareness = (payload) => win.webview.rpc?.send.collabAwareness(payload);
  sendCollabActivity = (payload) => win.webview.rpc?.send.collabActivity(payload);
  sendCollabHistoryChanged = (payload) => win.webview.rpc?.send.collabHistoryChanged(payload);
  sendOllamaProxyChunk = (payload) => win.webview.rpc?.send.ollamaProxyChunk(payload);
  sendBibliographyValidationProgress = (payload) =>
    win.webview.rpc?.send.bibliographyValidationProgress(payload);

  // ── Menu action events ──────────────────────────────────────
  Electrobun.events.on("application-menu-clicked", (e) => {
    const action = e.data.action;
    if (action === "aboutScholarPen") {
      win.webview.rpc?.send.menuAction({ action });
    } else if (action === "save" || action === "newDocument" || action === "exportMarkdown" || action === "importMarkdown" || action === "findReplaceDocuments") {
      win.webview.rpc?.send.menuAction({ action });
    } else if (action === "quit") {
      // Save first, then quit after a brief flush window
      win.webview.rpc?.send.menuAction({ action: "save" });
      setTimeout(() => {
        void collabHistory.flush().catch(() => undefined)
          .then(() => collabRegistry.flush()).finally(() => Utils.quit());
      }, 400);
    }
  });

  console.log("[ScholarPen] App started");
}

Electrobun.events.on("before-quit", () => {
  authorStyleScheduler.stop();
  void shutdownExtensions();
  codexClient.close();
  claudeClient.close();
  void collabHistory.flush().catch(() => undefined).then(() => collabRegistry.flush());
});

main().catch(console.error);

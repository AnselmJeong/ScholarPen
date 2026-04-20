import Electrobun, { BrowserView, BrowserWindow, ApplicationMenu, Utils } from "electrobun/bun";
import { readFile } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { basename, extname, join } from "path";
import { ollamaClient } from "./ollama/client";
import { claudeClient, buildSubprocessEnv, getUnsupportedInteractiveCommand } from "./claude/client";
import { citationClient } from "./citation/client";
import { fileSystem } from "./fs/manager";
import { findKBRoot, getKBEngine, type KBSearchResult } from "./kb/search";
import { buildKBGraph } from "./kb/graph";
import type { ScholarRPC } from "../shared/scholar-rpc";


// Build KB context string to prepend to the user's message.
// Uses XML-style tags — Claude understands these well and they
// won't be mistaken for CLI option flags (unlike leading "---").
function buildKBContext(results: KBSearchResult[], lang?: string): string {
  const items = results.map((r, i) => {
    const excerpt = r.excerpt
      ? `\n    ${r.excerpt.replace(/\n+/g, " ").trim().slice(0, 300)}`
      : "";
    return `[${i + 1}] ${r.title || r.docId} (${r.docType})${excerpt}`;
  });

  // CRITICAL: Language rule MUST be followed - place it first
  const langRule = lang === "ko"
    ? "0. CRITICAL — LANGUAGE: 답변은 반드시 한국어(Korean)로만 작성하세요. 영어로 작성하면 안 됩니다."
    : lang === "en"
      ? "0. CRITICAL — LANGUAGE: Respond in English ONLY. Do not use any other language."
      : "";

  const formatRule = lang === "ko"
    ? "6. 답변 구조: 먼저 질문에 대한 상세 설명을 작성하고, 각 주장 뒤에 [1], [2] 등으로 인용하세요. 설명 뒤에 References 목록이 자동으로 추가되므로 여기서는 생략하세요. 설명 없이 References만 적지 마세요."
    : "6. Structure: First write a detailed explanation with inline citations [1], [2], etc. A References list will be appended automatically — do not include it. Never respond with only References.";

  return [
    "<kb_context>",
    "STRICT RULES — follow exactly (highest priority first):",
    langRule,
    "1. Answer primarily from the references listed below using inline citations [1], [2], etc.",
    "2. If the user explicitly references a specific file (e.g., '@filename.pdf'), use Read/Glob tools to access that file's full content.",
    "3. Do not fabricate content absent from the references or the explicitly requested file.",
    "4. Do NOT use WebSearch or WebFetch — only use local file tools (Read, Glob) when needed.",
    "5. Cite every claim with [1], [2], etc. immediately after the sentence.",
    formatRule,
    "",
    "References:",
    ...items,
    "</kb_context>",
  ].filter(Boolean).join("\n");
}

// Append a formatted reference list after Claude's response.
// Uses https://x-sp-ref<path> so react-markdown doesn't sanitize the URL away
// (custom schemes like file-ref:// get stripped by the default URL sanitizer).
function buildReferenceList(results: KBSearchResult[]): string {
  const lines = results.map((r, i) => {
    const title = r.title || r.docId;
    const fileName = basename(r.filePath);
    // Encode each path segment individually to preserve slashes
    const encodedPath = r.filePath.split("/").map(encodeURIComponent).join("/");
    return `${i + 1}. **[${title}](https://x-sp-ref${encodedPath})** — \`${fileName}\``;
  });
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
let sendProjectUpdated: ((payload: { projectPath: string; filePath?: string }) => void) | null = null;
let sendAiChunk: ((payload: { content: string; done: boolean }) => void) | null = null;

// Tracks the in-flight Ollama stream so `abortAiStream` can cancel it.
let activeAiAbortController: AbortController | null = null;
let activeClaudeAbortController: AbortController | null = null;

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
          return fileSystem.saveBibtex(projectPath, bibtex);
        },

        saveBibtexRaw: async ({ projectPath, bibtex }) => {
          recentlySavedFiles.add("references.bib");
          setTimeout(() => recentlySavedFiles.delete("references.bib"), 3000);
          return fileSystem.saveBibtexRaw(projectPath, bibtex);
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

        // ── Claude CLI streaming ───────────────────────────
        getClaudeSlashCommands: ({ projectPath }) => claudeClient.getSlashCommands(projectPath),

        openExternal: ({ url }) => { openValidatedExternalUrl(url); },

        // Fire-and-forget: return immediately so Electrobun can process
        // outbound claudeChunk messages while Claude streams in background.
        claudeStream: async ({ message, sessionId, projectPath, kbEnabled, lang }) => {
          const unsupportedCommand = getUnsupportedInteractiveCommand(message);
          if (unsupportedCommand) {
            sendClaudeChunk?.({
              content: `⚠️ \`${unsupportedCommand}\` 명령은 대화형 Claude CLI 명령이라 ScholarPen 채팅에서는 지원되지 않습니다.`,
              done: false,
            });
            sendClaudeChunk?.({ content: "", done: true, sessionId: sessionId ?? undefined });
            return;
          }

          activeClaudeAbortController?.abort();
          const controller = new AbortController();
          activeClaudeAbortController = controller;

          const settings = await fileSystem.getSettings();
          const backend = settings.aiBackend ?? "ollama";
          const model = backend === "claude"
            ? (settings.claudeModel || "claude-sonnet-4-6")
            : (settings.ollamaDefaultModel || "qwen3.5:cloud");

          let enrichedMessage = message;
          let kbResults: import("./kb/search").KBSearchResult[] = [];

          // Slash commands (e.g. /kb-query, /lit-search) handle their own
          // context via skill definitions and need full tool access (Read, Glob, etc.).
          // Skip KB injection and tool restriction for them.
          const isSlashCommand = message.trimStart().startsWith("/");

          // Inject KB context when enabled and project has a KB
          // Search uses the raw message (no language prefix) to keep FTS accurate
          if (!isSlashCommand && kbEnabled !== false && projectPath) {
            try {
              const kbRoot = await findKBRoot(projectPath);
              if (kbRoot) {
                const engine = getKBEngine(kbRoot);
                await engine.ensureIndexed();
                const topK = settings.kbTopK || 5;
                kbResults = engine.search(message, topK);
                if (kbResults.length > 0) {
                  enrichedMessage = buildKBContext(kbResults, lang) + "\n\n" + message;
                }
              }
            } catch (err) {
              console.warn("[KB] Context injection failed, proceeding without KB:", err);
            }
          }

          // Append language instruction AFTER KB context injection so it
          // does not pollute the FTS search query above.
          // Add both before and after as reinforcement.
          const hasKB = !isSlashCommand && kbResults.length > 0;
          if (lang === "en") {
            const langInstruction = "[CRITICAL: Respond in English ONLY. Do not use other languages.]";
            enrichedMessage = langInstruction + "\n\n" + enrichedMessage + "\n\n" + langInstruction;
          } else if (lang === "ko") {
            const langInstruction = "[CRITICAL: 반드시 한국어로만 답변하세요. 영어로 답변하지 마세요.]";
            enrichedMessage = langInstruction + "\n\n" + enrichedMessage + "\n\n" + langInstruction;
          }

          const usingKB = !isSlashCommand && kbResults.length > 0;

          // KB mode: block external search tools (WebSearch, WebFetch); Normal mode: allow all tools
          const KB_TOOLS = "Bash,Read,Edit,Glob,Grep,Write,AskUserQuestion,TaskCreate,TaskUpdate,TaskList,TaskGet";
          const allowedTools = usingKB ? KB_TOOLS : undefined;

          claudeClient.streamChat(enrichedMessage, sessionId, projectPath, model, {
            onChunk: (text) => sendClaudeChunk?.({ content: text, done: false }),
            onDone: (newSessionId) => {
              try {
                if (usingKB && kbResults.length > 0) {
                  sendClaudeChunk?.({ content: buildReferenceList(kbResults), done: false });
                }
              } catch (err) {
                console.error("[KB] buildReferenceList failed:", err);
              }
              sendClaudeChunk?.({ content: "", done: true, sessionId: newSessionId });
            },
            onInit: (slashCommands) =>
              sendClaudeChunk?.({ content: "", done: false, slashCommands }),
          }, backend, allowedTools, controller.signal).catch((err) => {
            sendClaudeChunk?.({ content: `\n\n❌ 오류: ${err.message}`, done: false });
            sendClaudeChunk?.({ content: "", done: true });
          }).finally(() => {
            if (activeClaudeAbortController === controller) {
              activeClaudeAbortController = null;
            }
          });
        },

        abortClaudeStream: () => {
          activeClaudeAbortController?.abort();
        },

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
  sendAiChunk = (payload) => win.webview.rpc?.send.aiChunk(payload);

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

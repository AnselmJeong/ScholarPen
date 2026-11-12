import { ExtensionSlot, ExtensionWorkspaceProvider } from "./extensions/slots";
import { RevisionResponseEditor } from "./components/review/RevisionResponseEditor";
import { ResponseDrafts } from "./components/review/response-drafts";
import { OriginalManuscriptPane } from "./components/review/OriginalManuscriptPane";
import { RevisionContextPanel, useRevisionContext } from "./components/review/RevisionContextPanel";
import { ReviewWorkspace } from "./components/review/ReviewWorkspace";
import React, { Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { PanelRightClose, PanelRightOpen, PenLine, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { LeftSidebar } from "./components/sidebar/LeftSidebar";
import { EditorPaneGroup, type EditorPaneGroupHandle } from "./components/editor/EditorPaneGroup";
import { StatusBar } from "./components/editor/StatusBar";
import { ExportDialog, type ExportProgress } from "./components/editor/ExportDialog";
import { documentRelativeFilename, editingProject } from "./utils/document-tree";
import { AboutDialog } from "./components/AboutDialog";
import { SettingsPage } from "./components/settings/SettingsPage";
import { rpc, onMenuAction, onImportMarkdown, onProjectUpdated } from "./rpc";
import {
  blocksToScholarMarkdown,
  documentTitleFromFilename,
  type ExportFormat,
} from "./blocks/markdown-serializer";
import { markdownToScholarBlocks } from "./blocks/markdown-parser";
import { scholarSchema } from "./blocks/schema";
import { collectDocumentNodes } from "./utils/document-tree";
import type {
  AppSettings,
  FileNode,
  OllamaStatus,
  ProjectInfo,
} from "../shared/rpc-types";
import { DEFAULT_OLLAMA_BASE_URL } from "../shared/ollama-connection";
import { BlockNoteEditor } from "@blocknote/core";
import type { DeepenAnalysisRequest } from "./ai/deepen-analysis";
import type { FindCitationRequest } from "./ai/find-citation";
import type { CitationCheckRequest } from "./ai/check-citations";
import { useAIResponsePreferences } from "./hooks/useAIResponsePreferences";
import { normalizeProjectRelativePath, type ProjectFileReference } from "../shared/project-file-reference";
import packageJson from "../../package.json";
import { ActivityPanel, ActivityPanelHeader, type RightPanelTab } from "./components/sidebar/ActivityPanel";
import { HistoryPanel } from "./components/sidebar/HistoryPanel";
import { getEditorCollab } from "./collab/editor-collab";
import { ProjectPanel } from "./components/sidebar/ProjectPanel";

type AppView = "editor" | "settings";
type SaveStatus = "saved" | "saving" | "unsaved";
const AISidebar = lazy(() => import("./components/sidebar/AISidebar").then((m) => ({ default: m.AISidebar })));

export function App() {
  const { preferences: aiResponsePreferences, setSearchEnabled, setThinkingLevel } = useAIResponsePreferences();
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    connected: false,
    models: [],
    activeModel: null,
  });
  const [projects, setProjects]                       = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject]             = useState<ProjectInfo | null>(null);
  const [fileTree, setFileTree]                       = useState<FileNode[]>([]);
  const [activeFile, setActiveFile]                   = useState<FileNode | null>(null);
  const activeEditingProject = useMemo(() => editingProject(activeProject, activeFile?.path), [activeProject, activeFile?.path]);
  const [activeDocumentFilename, setActiveDocumentFilename] = useState<string | null>(null);
  const [currentView, setCurrentView]                 = useState<AppView>("editor");
  const [aiSidebarOpen, setAiSidebarOpen]             = useState(false);
  const [rightPanelTab, setRightPanelTab]             = useState<RightPanelTab>("activity");
  const isRevisionDocument = activeFile?.kind === "document" && activeEditingProject?.path !== activeProject?.path;
  const revisionFilename = isRevisionDocument && activeEditingProject && activeFile ? documentRelativeFilename(activeEditingProject.path, activeFile.path) : undefined;
  const [revisionView, setRevisionView] = useState<"manuscript" | "response">("manuscript");
  const responseDrafts = useMemo(() => new ResponseDrafts(request => rpc.reviewSaveRevisionResponse(request)), []);
  useSyncExternalStore(responseDrafts.subscribe, responseDrafts.snapshot);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (responseDrafts.hasPending()) { void responseDrafts.flushAll(); event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); void responseDrafts.flushAll(); };
  }, [responseDrafts]);
  const saveReviewResponses = useCallback(async () => { if (activeProject) await responseDrafts.prepareReview(activeProject.path); }, [activeProject?.path, responseDrafts]);
  const revisionContext = useRevisionContext(isRevisionDocument ? activeEditingProject?.path : undefined, revisionFilename);
  useEffect(() => {
    if (isRevisionDocument) { setRightPanelTab("revision"); setAiSidebarOpen(true); setLeftSidebarOpen(false); }
    else setRightPanelTab(tab => tab === "revision" ? "activity" : tab);
  }, [activeFile?.path, activeProject?.path, isRevisionDocument]);
  const [activeEditor, setActiveEditor]               = useState<BlockNoteEditor<any, any, any> | null>(null);

  const [leftSidebarOpen, setLeftSidebarOpen]         = useState(true);
  const [pendingDeepenRequest, setPendingDeepenRequest] = useState<DeepenAnalysisRequest | null>(null);
  const [pendingFindCitationRequest, setPendingFindCitationRequest] = useState<FindCitationRequest | null>(null);
  const [pendingCitationCheckRequest, setPendingCitationCheckRequest] = useState<CitationCheckRequest | null>(null);
  const [saveStatus, setSaveStatus]                   = useState<SaveStatus>("saved");
  const [exportDialogOpen, setExportDialogOpen]       = useState(false);
  const [exportTargets, setExportTargets]             = useState<FileNode[]>([]);
  const [aiSidebarWidth, setAiSidebarWidth]           = useState(576);
  const [revisionSidebarWidth, setRevisionSidebarWidth] = useState(320);
  const [leftSidebarWidth, setLeftSidebarWidth]       = useState(280);
  const [editorReloadTrigger, setEditorReloadTrigger] = useState(0);
  const [bibReloadTrigger, setBibReloadTrigger]       = useState(0);
  const [reviewWorkspaceOpen, setReviewWorkspaceOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<Pick<AppSettings, "sidebarAgentProvider" | "sidebarAgentModel" | "ollamaBaseUrl" | "webSearchEnabled">>({
    sidebarAgentProvider: "ollama",
    sidebarAgentModel: "qwen3.5:397b",
    ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    webSearchEnabled: true,
  });

  const editorRef      = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const exportEditorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const editorGroupRef = useRef<EditorPaneGroupHandle | null>(null);
  const pendingProjectFindReplaceRef = useRef(false);
  const deepenRevisionAppliersRef = useRef(
    new Map<string, (protectedRevision: string | null) => string | null>(),
  );
  // Citation check revisions are staged only when the author asks, so appliers stay until used.
  const citationCheckAppliersRef = useRef(
    new Map<string, (protectedRevision: string | null) => string | null>(),
  );
  const handleDeepenResult = useCallback(
    (requestId: string, protectedRevision: string | null) => {
      const applyRevision = deepenRevisionAppliersRef.current.get(requestId);
      deepenRevisionAppliersRef.current.delete(requestId);
      if (!protectedRevision) return applyRevision?.(null) ?? null;
      if (!applyRevision) {
        return "원래 편집 세션을 찾을 수 없어 문서를 변경하지 않았습니다.";
      }
      return applyRevision(protectedRevision);
    },
    [],
  );

  const handleApplyCitationRevision = useCallback(
    (requestId: string, protectedRevision: string) => {
      const applyRevision = citationCheckAppliersRef.current.get(requestId);
      if (!applyRevision) return "원래 편집 세션을 찾을 수 없어 문서를 변경하지 않았습니다. 해당 부분을 다시 선택해 확인해 주세요.";
      const error = applyRevision(protectedRevision);
      if (!error) citationCheckAppliersRef.current.delete(requestId);
      return error;
    },
    [],
  );

  // Resize refs — Left sidebar
  const isResizingLeftRef    = useRef(false);
  const resizeLeftStartRef   = useRef({ x: 0, width: 0 });
  // Resize refs — AI sidebar
  const isResizingAIRef    = useRef(false);
  const resizeAIStartRef   = useRef({ x: 0, width: 0 });

  // Poll Ollama status every 10s
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const status = await rpc.getOllamaStatus();
        if (!cancelled) setOllamaStatus(status);
      } catch {
        if (!cancelled) setOllamaStatus({ connected: false, models: [], activeModel: null });
      }
    };
    check();
    const id = setInterval(check, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (
      appSettings.sidebarAgentProvider === "ollama" &&
      ollamaStatus.activeModel &&
      !ollamaStatus.models.includes(appSettings.sidebarAgentModel)
    ) {
      setAppSettings((current) => ({
        ...current,
        sidebarAgentModel: ollamaStatus.activeModel!,
      }));
    }
  }, [
    appSettings.sidebarAgentProvider,
    appSettings.sidebarAgentModel,
    ollamaStatus.activeModel,
    ollamaStatus.models,
  ]);

  const refreshProjects = useCallback(() => {
    rpc.listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => { refreshProjects(); }, []);

  // Load AI backend setting once on mount
  useEffect(() => {
    rpc.getSettings()
      .then((s) => setAppSettings({
        sidebarAgentProvider: s.sidebarAgentProvider ?? "ollama",
        sidebarAgentModel: s.sidebarAgentModel ?? s.ollamaDefaultModel ?? "qwen3.5:397b",
        ollamaBaseUrl: s.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        webSearchEnabled: s.webSearchEnabled,
      }))
      .catch(console.error);
  }, []);

  const refreshFileTree = useCallback(async () => {
    if (!activeProject) return;
    try {
      setFileTree(await rpc.listProjectFiles(activeProject.path));
    } catch {
      setFileTree([]);
    }
  }, [activeProject]);

  const handleProjectChange = useCallback(async (project: ProjectInfo) => {
    setActiveProject(project);
    setActiveFile(null);
    setActiveDocumentFilename(null);
    setExportTargets([]);
    setExportDialogOpen(false);
    try {
      const tree = await rpc.listProjectFiles(project.path);
      setFileTree(tree);
      const docsDir = tree.find(n => n.name === "documents" && n.isDirectory);
      if (docsDir?.children?.length) {
        const first = docsDir.children.find(c => c.kind === "document" && !c.isDirectory);
        if (first) {
          setActiveFile(first);
          setActiveDocumentFilename(first.name);
          setCurrentView("editor");
        }
      }
    } catch {
      setFileTree([]);
    }
  }, []);

  const handleCreateProject = useCallback(async (name: string) => {
    const project = await rpc.createProject(name);
    setProjects(prev => [project, ...prev]);
    await handleProjectChange(project);
  }, [handleProjectChange]);

  const handleFileSelect = useCallback((file: FileNode) => {
    if (file.isDirectory) return;
    setReviewWorkspaceOpen(false);
    editorGroupRef.current?.openFile(file);
    setCurrentView("editor");
  }, []);

  const handleOpenProjectSource = useCallback((reference: ProjectFileReference) => {
    if (!activeEditingProject) return;
    const relativePath = normalizeProjectRelativePath(reference.relativePath);
    if (!relativePath) return;
    const name = relativePath.split("/").at(-1) ?? relativePath;
    const extension = name.split(".").at(-1)?.toLowerCase();
    handleFileSelect({
      name,
      path: `${activeEditingProject.path.replace(/\/$/, "")}/${relativePath}`,
      kind: extension === "pdf" ? "pdf" : extension === "md" ? "note" : "unknown",
      isDirectory: false,
      lastModified: Date.now(),
      initialPage: reference.page,
    });
  }, [activeEditingProject, handleFileSelect, refreshFileTree]);

  const handleEditorReady = useCallback((editor: BlockNoteEditor<any, any, any> | null) => {
    editorRef.current = editor;
    setActiveEditor(editor);
    if (editor && pendingProjectFindReplaceRef.current) {
      pendingProjectFindReplaceRef.current = false;
      requestAnimationFrame(() => {
        (editor as any).__scholarpenOpenProjectFindReplace?.();
      });
    }
  }, []);

  const handleOpenProjectFindReplace = useCallback(() => {
    if (editorGroupRef.current?.openProjectFindReplace()) return;
    const target = activeFile?.kind === "document"
      ? activeFile
      : collectDocumentNodes(fileTree)[0];
    if (!target) return;
    pendingProjectFindReplaceRef.current = true;
    editorGroupRef.current?.openFile(target);
    setCurrentView("editor");
  }, [activeFile, fileTree]);

  // ── Menu actions ──────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onMenuAction((action) => {
      switch (action) {
        case "aboutScholarPen":
          setAboutDialogOpen(true);
          break;
        case "newDocument":
          if (activeProject) {
            const ts = new Date().toISOString().slice(0, 10);
            rpc.createDocument(activeProject.path, `Untitled-${ts}.scholarpen.json`)
              .then(async (created) => {
                setActiveDocumentFilename(created);
                setActiveFile(null);
                setCurrentView("editor");
              })
              .catch(console.error);
          }
          break;
        case "save": {
          void responseDrafts.flushAll();
          editorGroupRef.current?.saveActiveEditor();
          // Saving also ends the current history checkpoint, so it is there to come back to.
          const collab = editorRef.current ? getEditorCollab(editorRef.current) : null;
          if (collab) void collab.afterPushes(() => rpc.collabHistoryCheckpoint(collab.docKey)).catch(() => undefined);
          break;
        }
        case "exportMarkdown":
          if (activeFile?.kind === "document") {
            setExportTargets([activeFile]);
            setExportDialogOpen(true);
          }
          break;
        case "importMarkdown":
          handleImportMarkdown();
          break;
        case "findReplaceDocuments":
          handleOpenProjectFindReplace();
          break;
      }
    });
    return unsub;
  }, [activeProject, activeDocumentFilename, activeFile, handleOpenProjectFindReplace]);

  useEffect(() => {
    const unsub = onImportMarkdown(async (content, suggestedFilename) => {
      if (!activeProject) return;
      try {
        const blocks = await markdownToScholarBlocks(content);
        const safe = suggestedFilename.endsWith(".scholarpen.json")
          ? suggestedFilename
          : suggestedFilename.replace(/\.md$|\.qmd$|\.txt$/, "") + ".scholarpen.json";
        const created = await rpc.createDocument(activeProject.path, safe, blocks);
        await refreshFileTree();
        setActiveDocumentFilename(created);
        setActiveFile(null);
        setCurrentView("editor");
      } catch (err) {
        console.error("Import failed:", err);
      }
    });
    return unsub;
  }, [activeProject, refreshFileTree]);

  const handleImportMarkdown = useCallback(async () => {
    if (!activeProject) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.qmd,.txt,.markdown";
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      const failures: string[] = [];
      let lastCreated: string | undefined;
      for (const file of files) {
        try {
          const blocks = await markdownToScholarBlocks(await file.text());
          const suggestedFilename = file.name.replace(/\.[^.]+$/, "") + ".scholarpen.json";
          lastCreated = await rpc.createDocument(activeProject.path, suggestedFilename, blocks);
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await refreshFileTree();
      if (lastCreated) handleFileSelect({ name: lastCreated, path: `${activeProject.path}/documents/${lastCreated}`,
        kind: "document", isDirectory: false, lastModified: Date.now() });
      if (failures.length) window.alert(`Imported ${files.length - failures.length}/${files.length} files.\n${failures.join("\n")}`);
    };
    input.click();
  }, [activeProject, refreshFileTree, handleFileSelect]);

  const openExportDialog = useCallback((documents: FileNode[]) => {
    if (documents.length === 0) return;
    setExportTargets(documents);
    setExportDialogOpen(true);
  }, []);

  const handleExport = useCallback(async (format: ExportFormat, onProgress: (progress: ExportProgress) => void) => {
    if (!activeProject || exportTargets.length === 0) return;

    const serializerEditor = exportEditorRef.current ??= BlockNoteEditor.create({ schema: scholarSchema });
    const ext = format === "qmd" ? ".qmd" : ".md";

    for (const [index, target] of exportTargets.entries()) {
      const targetProject = editingProject(activeProject, target.path)!;
      const filename = documentRelativeFilename(targetProject.path, target.path);
      const progress = { current: index + 1, total: exportTargets.length, filename };
      onProgress({ ...progress, stage: "reading" });
      const openSnapshot = editorGroupRef.current?.getDocumentSnapshot(target.path);
      const blocks = openSnapshot ?? await rpc.loadDocument(targetProject.path, filename);
      if (!Array.isArray(blocks)) {
        throw new Error(`Document "${target.name}" does not contain a valid block array.`);
      }
      const docName = target.name.replace(/\.scholarpen\.json$/, "");
      const title = documentTitleFromFilename(target.name);
      onProgress({ ...progress, stage: "converting" });
      const markdown = await blocksToScholarMarkdown(
        serializerEditor,
        blocks as any,
        format,
        title,
        { filename: docName + ext },
      );
      onProgress({ ...progress, stage: "saving" });
      await rpc.exportFile(targetProject.path, docName + ext, markdown);
    }

    // Every file is already saved. A slow cloud directory listing must not hold the dialog open.
    void refreshFileTree();
  }, [activeProject, exportTargets, refreshFileTree]);

  const handleImportFromFile = useCallback(async (filePath: string, openDocument = true) => {
    if (!activeProject) throw new Error("Open a project first.");
    const content = await rpc.readTextFile(filePath);
    const blocks = await markdownToScholarBlocks(content);
    const baseName = filePath.replace(/.*\//, "").replace(/\.[^.]+$/, "");
    const created = await rpc.createDocument(activeProject.path, `${baseName}.scholarpen.json`, blocks);
    if (openDocument) {
      await refreshFileTree();
      handleFileSelect({ name: created, path: `${activeProject.path}/documents/${created}`,
        kind: "document", isDirectory: false, lastModified: Date.now() });
    }
  }, [activeProject, refreshFileTree, handleFileSelect]);

  const handleFileRenamed = useCallback((_newPath: string, _newName: string) => {}, []);

  const handleDeleteFile = useCallback(async (filePath: string) => {
    const resume = await editorGroupRef.current?.prepareFileDeletion(filePath);
    try {
      await rpc.deleteFile(filePath);
      editorGroupRef.current?.closeFileByPath(filePath);
    } catch (error) {
      resume?.();
      throw error;
    }
  }, []);

  useEffect(() => {
    return onProjectUpdated((updatedPath, filePath) => {
      if (!activeProject || updatedPath !== activeProject.path) return;
      refreshFileTree();
      if (filePath?.endsWith("/references.bib")) {
        setBibReloadTrigger(n => n + 1);
      } else if (!filePath || filePath.endsWith(`/${activeDocumentFilename ?? ""}`)) {
        setEditorReloadTrigger(n => n + 1);
      }
    });
  }, [activeProject, activeDocumentFilename, refreshFileTree]);

  // ── Left sidebar resize ────────────────────────────────────────────────────

  const handleLeftResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingLeftRef.current = true;
    resizeLeftStartRef.current = { x: e.clientX, width: leftSidebarWidth };
    const onMove = (ev: MouseEvent) => {
      if (!isResizingLeftRef.current) return;
      const delta = ev.clientX - resizeLeftStartRef.current.x;
      setLeftSidebarWidth(Math.max(200, Math.min(480, resizeLeftStartRef.current.width + delta)));
    };
    const onUp = () => {
      isResizingLeftRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [leftSidebarWidth]);

  // ── AI sidebar resize ─────────────────────────────────────────────────────

  const handleAIResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingAIRef.current = true;
    resizeAIStartRef.current = { x: e.clientX, width: rightPanelTab === "revision" ? revisionSidebarWidth : aiSidebarWidth };
    const onMove = (ev: MouseEvent) => {
      if (!isResizingAIRef.current) return;
      const delta = resizeAIStartRef.current.x - ev.clientX;
      const updateWidth = rightPanelTab === "revision" ? setRevisionSidebarWidth : setAiSidebarWidth;
      updateWidth(Math.max(220, Math.min(640, resizeAIStartRef.current.width + delta)));
    };
    const onUp = () => {
      isResizingAIRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [aiSidebarWidth, revisionSidebarWidth, rightPanelTab]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ExtensionWorkspaceProvider value={{ project: activeProject, editingProject: activeEditingProject, activeFile, files: fileTree, editor: activeEditor,
      selectFile: handleFileSelect, setFiles: setFileTree, refreshFiles: refreshFileTree, reloadBibliography: () => setBibReloadTrigger(value => value + 1) }}>
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-5 h-12 flex-shrink-0" style={{ background: "hsl(var(--background))", boxShadow: "0 1px 0 rgba(91,33,182,0.08)" }}>
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0"
               style={{ background: "linear-gradient(135deg, #5b21b6 0%, #4c1d95 100%)" }}>
            <PenLine className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight text-foreground">ScholarPen</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setCurrentView("settings")}
            title="Settings" aria-label="Settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <Settings className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          </button>
          <ExtensionSlot name="toolbar" />

          <button disabled={!activeProject} onClick={() => { setReviewWorkspaceOpen(true); setAiSidebarOpen(false); }} className="flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium text-primary hover:bg-accent disabled:opacity-40">Review &amp; Revision</button>
          <button
            type="button"
            onClick={() => setAiSidebarOpen(open => !open)}
            title={aiSidebarOpen ? "Hide AI sidebar" : "Show AI sidebar"}
            aria-label={aiSidebarOpen ? "Hide AI sidebar" : "Show AI sidebar"}
            aria-expanded={aiSidebarOpen}
            aria-controls="ai-sidebar"
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${aiSidebarOpen ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
          >
            {aiSidebarOpen
              ? <PanelRightClose className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              : <PanelRightOpen className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
          </button>
        </div>
      </header>

      {/* 3-pane layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Files panel */}
        {/* Keep the explorer mounted to preserve folder, selection, and scroll state. */}
        <div id="files-panel" hidden={!leftSidebarOpen} style={{ width: leftSidebarWidth }} className="flex-shrink-0 h-full">
          <LeftSidebar
            projects={projects}
            activeProject={activeProject}
            onProjectChange={handleProjectChange}
            onCreateProject={handleCreateProject}
            fileTree={fileTree}
            activeFile={activeFile}
            onFileSelect={handleFileSelect}
            onOpenSettings={() => setCurrentView("settings")}
            onRefreshTree={refreshFileTree}
            onExportDocuments={openExportDialog}
            onFindReplaceDocuments={handleOpenProjectFindReplace}
            onImportFile={handleImportFromFile}
            onFileRenamed={handleFileRenamed}
            onDeleteFile={handleDeleteFile}
          />
        </div>
        {/* Resize handle */}
        <div
          hidden={!leftSidebarOpen}
          className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/40 transition-colors"
          onMouseDown={handleLeftResizeMouseDown}
        />

        {/* Center: Editor, with Settings overlay kept in the same workspace */}
        <div data-revision-comparison={isRevisionDocument || undefined} className="relative flex flex-1 overflow-hidden">
          {isRevisionDocument && activeFile && revisionContext.data && <style>{revisionContext.data.changes.map(change => {
            const id = change.target.split("#")[1]?.split(":")[0];
            return id ? `[data-revision-document="${CSS.escape(activeFile.path)}"] .bn-block-outer[data-id="${CSS.escape(id)}"] > .bn-block { border-left: 2px solid hsl(var(--primary)); background: hsl(var(--primary) / 0.04); }` : "";
          }).join("\n")}</style>}
          {reviewWorkspaceOpen && activeProject && <ReviewWorkspace key={activeProject.path} project={activeProject} files={fileTree} activeDocument={activeDocumentFilename} saveResponses={saveReviewResponses} onExported={refreshFileTree} prepare={async () => { await editorGroupRef.current?.prepareReview(); }} onClose={() => setReviewWorkspaceOpen(false)} onOpenRevision={async (path, filename) => { setReviewWorkspaceOpen(false); handleFileSelect({ name: filename.split("/").at(-1)!, path: `${path}/documents/${filename}`, kind: "document", isDirectory: false, lastModified: Date.now() }); }} />}
          {/* Editor */}
          <EditorPaneGroup
            originalPane={isRevisionDocument ? <OriginalManuscriptPane state={revisionContext} /> : undefined}
            responsePane={<RevisionResponseEditor state={revisionContext} projectPath={activeEditingProject?.path} drafts={responseDrafts} />}
            revisionView={revisionView}
            onRevisionViewChange={setRevisionView}
            filesOpen={leftSidebarOpen}
            onToggleFiles={() => setLeftSidebarOpen(open => !open)}
            ref={editorGroupRef}
            project={activeProject}
            ollamaStatus={ollamaStatus}
            reloadTrigger={editorReloadTrigger}
            bibReloadTrigger={bibReloadTrigger}
            onActiveFileChange={(file, docFilename) => {
              setActiveFile(file);
              setActiveDocumentFilename(docFilename);
            }}
            onActiveEditorChange={handleEditorReady}
            onSaveStatusChange={setSaveStatus}
            onBibtexSaved={() => setBibReloadTrigger(n => n + 1)}
            onDeepenAnalysis={(request, applyRevision) => {
              setPendingDeepenRequest((current) => {
                if (current) deepenRevisionAppliersRef.current.delete(current.id);
                return request;
              });
              deepenRevisionAppliersRef.current.set(request.id, applyRevision);
              setPendingFindCitationRequest(null);
              setPendingCitationCheckRequest(null);
              setRightPanelTab("assistant");
              setAiSidebarOpen(true);
            }}
            onReviewChanges={() => {
              setRightPanelTab("activity");
              setAiSidebarOpen(true);
            }}
            onFindCitation={(request) => {
              setPendingDeepenRequest((current) => {
                if (current) deepenRevisionAppliersRef.current.delete(current.id);
                return null;
              });
              setPendingCitationCheckRequest(null);
              setPendingFindCitationRequest(request);
              setRightPanelTab("assistant");
              setAiSidebarOpen(true);
            }}
            onCheckCitations={(request, applyRevision) => {
              setPendingDeepenRequest((current) => {
                if (current) deepenRevisionAppliersRef.current.delete(current.id);
                return null;
              });
              setPendingFindCitationRequest(null);
              citationCheckAppliersRef.current.set(request.id, applyRevision);
              setPendingCitationCheckRequest(request);
              setRightPanelTab("assistant");
              setAiSidebarOpen(true);
            }}
          />

          {currentView === "settings" && (
            <div className="absolute inset-0 z-20 flex bg-background">
              <SettingsPage
                ollamaStatus={ollamaStatus}
                onClose={() => setCurrentView("editor")}
                onSettingsSaved={(saved) => {
                  refreshProjects();
                  setAppSettings({
                    sidebarAgentProvider: saved.sidebarAgentProvider ?? "ollama",
                    sidebarAgentModel: saved.sidebarAgentModel ?? saved.ollamaDefaultModel ?? "qwen3.5:397b",
                    ollamaBaseUrl: saved.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
                    webSearchEnabled: saved.webSearchEnabled,
                  });
                }}
              />
            </div>
          )}
        </div>

        {/* Right: AI Sidebar */}
        {aiSidebarOpen && (
          <>
            <div
              className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/40 transition-colors"
              onMouseDown={handleAIResizeMouseDown}
            />
            <div id="ai-sidebar" className="flex h-full flex-shrink-0 flex-col border-l border-border bg-background" style={{ width: rightPanelTab === "revision" ? revisionSidebarWidth : aiSidebarWidth }}>
              <ActivityPanelHeader revisionAvailable={Boolean(isRevisionDocument)} tab={rightPanelTab} onTab={setRightPanelTab} onClose={() => setAiSidebarOpen(false)} />
              {rightPanelTab === "revision" && <RevisionContextPanel state={revisionContext} filename={revisionFilename} editor={activeEditor} onShowManuscript={() => setRevisionView("manuscript")} />}
              <div className="flex min-h-0 flex-1 flex-col" style={{ display: rightPanelTab === "activity" ? "flex" : "none" }}>
                <ActivityPanel
                  editor={activeEditor}
                  projectPath={activeEditingProject?.path}
                  onExported={refreshFileTree}
                  documentName={activeFile?.kind === "document" ? activeFile.name : null}
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col" style={{ display: rightPanelTab === "history" ? "flex" : "none" }}>
                <HistoryPanel
                  editor={activeEditor}
                  documentName={activeFile?.kind === "document" ? activeFile.name : null}
                  active={rightPanelTab === "history"}
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col" style={{ display: rightPanelTab === "project" ? "flex" : "none" }}>
                {rightPanelTab === "project" && (
                  <ProjectPanel projectPath={activeEditingProject?.path} onOpenDocument={(filename) => {
                    if (!activeEditingProject) return;
                    handleFileSelect({ name: filename.split("/").at(-1) ?? filename,
                      path: `${activeEditingProject.path.replace(/\/$/, "")}/documents/${filename}`,
                      kind: "document", isDirectory: false, lastModified: Date.now() });
                  }} />
                )}
              </div>
              <div className="flex min-h-0 flex-1 [&>*]:!border-l-0" style={{ display: rightPanelTab === "assistant" ? "flex" : "none" }}>
              <Suspense fallback={<div style={{ width: aiSidebarWidth }} className="h-full border-l border-border flex items-center justify-center text-sm text-muted-foreground">Loading AI...</div>}>
                <AISidebar
                  responsePreferences={aiResponsePreferences}
                  onSearchEnabledChange={setSearchEnabled}
                  onThinkingLevelChange={setThinkingLevel}
                  project={activeEditingProject}
                  ollamaStatus={ollamaStatus}
                  appSettings={appSettings}
                  editor={editorRef.current}
                  activeDocumentName={activeFile?.kind === "document" ? activeFile.name : null}
                  getActiveDocumentContext={() => editorGroupRef.current?.getActiveDocumentContext()}
                  onClose={() => setAiSidebarOpen(false)}
                  width={aiSidebarWidth}
                  deepenRequest={pendingDeepenRequest}
                  onDeepenRequestConsumed={(requestId) => {
                    setPendingDeepenRequest((current) =>
                      current?.id === requestId ? null : current,
                    );
                  }}
                  onDeepenResult={handleDeepenResult}
                  citationCheckRequest={pendingCitationCheckRequest}
                  onCitationCheckRequestConsumed={(requestId) => {
                    setPendingCitationCheckRequest((current) =>
                      current?.id === requestId ? null : current,
                    );
                  }}
                  onApplyCitationRevision={handleApplyCitationRevision}
                  findCitationRequest={pendingFindCitationRequest}
                  onFindCitationRequestConsumed={(requestId) => {
                    setPendingFindCitationRequest((current) =>
                      current?.id === requestId ? null : current,
                    );
                  }}
                  onOpenProjectSource={handleOpenProjectSource}
                />
              </Suspense>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Bottom: Status Bar */}
      <StatusBar
        ollamaStatus={ollamaStatus}
        sidebarAgentProvider={appSettings.sidebarAgentProvider}
        sidebarAgentModel={appSettings.sidebarAgentModel}
        onToggleAI={() => setAiSidebarOpen(v => !v)}
        saveStatus={saveStatus === "unsaved" || responseDrafts.status() === "unsaved" ? "unsaved" : saveStatus === "saving" || responseDrafts.status() === "saving" ? "saving" : "saved"}
      />

      {/* Export Dialog */}
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          setExportDialogOpen(open);
          if (!open) setExportTargets([]);
        }}
        onExport={handleExport}
        destination={activeProject ? `${activeProject.path}/exports` : undefined}
        documentNames={exportTargets.map((target) => target.name.replace(/\.scholarpen\.json$/, ""))}
      />

      <AboutDialog
        open={aboutDialogOpen}
        onOpenChange={setAboutDialogOpen}
        version={packageJson.version}
      />
    </div>
    </ExtensionWorkspaceProvider>
  );
}

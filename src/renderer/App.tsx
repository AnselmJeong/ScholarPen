import React, { useState, useEffect, useCallback, useRef } from "react";
import { PenLine } from "lucide-react";
import { LeftSidebar } from "./components/sidebar/LeftSidebar";
import { EditorPaneGroup, type EditorPaneGroupHandle } from "./components/editor/EditorPaneGroup";
import { AISidebar } from "./components/sidebar/AISidebar";
import { StatusBar } from "./components/editor/StatusBar";
import { ExportDialog } from "./components/editor/ExportDialog";
import { SettingsPage } from "./components/settings/SettingsPage";
import { KnowledgeGraphPanel } from "./components/graph/KnowledgeGraphPanel";
import { rpc, onMenuAction, onImportMarkdown, onProjectUpdated } from "./rpc";
import { blocksToScholarMarkdown, type ExportFormat } from "./blocks/markdown-serializer";
import { markdownToScholarBlocks } from "./blocks/markdown-parser";
import type { OllamaStatus, ProjectInfo, FileNode, KBGraph, KBGraphNode } from "../shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

type AppView = "editor" | "settings";
type SaveStatus = "saved" | "saving" | "unsaved";

export function App() {
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    connected: false,
    models: [],
    activeModel: null,
  });
  const [projects, setProjects]                       = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject]             = useState<ProjectInfo | null>(null);
  const [fileTree, setFileTree]                       = useState<FileNode[]>([]);
  const [activeFile, setActiveFile]                   = useState<FileNode | null>(null);
  const [activeDocumentFilename, setActiveDocumentFilename] = useState<string | null>(null);
  const [currentView, setCurrentView]                 = useState<AppView>("editor");
  const [aiSidebarOpen, setAiSidebarOpen]             = useState(false);
  const [wordCount, setWordCount]                     = useState(0);
  const [saveStatus, setSaveStatus]                   = useState<SaveStatus>("saved");
  const [exportDialogOpen, setExportDialogOpen]       = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth]           = useState(576);
  const [editorReloadTrigger, setEditorReloadTrigger] = useState(0);

  // ── KB Graph state ────────────────────────────────────────────────────────
  const [graphMode, setGraphMode]                 = useState(false);
  const [graphLoading, setGraphLoading]           = useState(false);
  const [kbGraph, setKbGraph]                     = useState<KBGraph | null>(null);
  const [graphSelectedNodeId, setGraphSelectedNodeId] = useState<string | null>(null);
  // Initial graph panel width = 2/3 of available space (viewport − sidebar − handle)
  const [graphPanelWidth, setGraphPanelWidth] = useState(() =>
    Math.round((window.innerWidth - 228) * 2 / 3)
  );

  const editorRef      = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const editorGroupRef = useRef<EditorPaneGroupHandle | null>(null);

  // Resize refs — AI sidebar
  const isResizingAIRef    = useRef(false);
  const resizeAIStartRef   = useRef({ x: 0, width: 0 });
  // Resize refs — graph panel
  const isResizingGraphRef   = useRef(false);
  const resizeGraphStartRef  = useRef({ x: 0, width: 0 });

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

  const refreshProjects = useCallback(() => {
    rpc.listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => { refreshProjects(); }, []);

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
    // Reset graph when switching projects
    setGraphMode(false);
    setKbGraph(null);
    setGraphSelectedNodeId(null);
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
    editorGroupRef.current?.openFile(file);
    setCurrentView("editor");
  }, []);

  const handleEditorReady = useCallback((editor: BlockNoteEditor<any, any, any> | null) => {
    editorRef.current = editor;
  }, []);

  // ── KB graph handlers ─────────────────────────────────────────────────────

  const handleToggleGraph = useCallback(async () => {
    if (graphMode) {
      setGraphMode(false);
      setGraphSelectedNodeId(null);
      return;
    }
    if (!activeProject) return;
    // Reuse cached graph if available; otherwise fetch
    if (kbGraph) {
      setGraphMode(true);
      setGraphSelectedNodeId(null);
      return;
    }
    setGraphLoading(true);
    try {
      const graph = await rpc.getKBGraph(activeProject.path);
      setKbGraph(graph);
      setGraphMode(true);
      setGraphSelectedNodeId(null);
    } catch (err) {
      console.error("Failed to load KB graph:", err);
    } finally {
      setGraphLoading(false);
    }
  }, [graphMode, activeProject, kbGraph]);

  const handleGraphNodeClick = useCallback((node: KBGraphNode) => {
    setGraphSelectedNodeId(node.id);
    // Construct a FileNode so EditorPaneGroup can open it in FileViewer
    const fileNode: FileNode = {
      name: node.title + ".md",
      path: node.filePath,
      kind: "note",
      isDirectory: false,
      lastModified: Date.now(),
    };
    editorGroupRef.current?.openFile(fileNode);
    setCurrentView("editor");
  }, []);

  const handleKnowledgeFileSelect = useCallback((filePath: string, title: string) => {
    const fileNode: FileNode = {
      name: title + ".md",
      path: filePath,
      kind: "note",
      isDirectory: false,
      lastModified: Date.now(),
    };
    editorGroupRef.current?.openFile(fileNode);
    setCurrentView("editor");
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+Shift+G — toggle graph
      if (e.metaKey && e.shiftKey && e.key === "g") {
        e.preventDefault();
        handleToggleGraph();
      }
      // Escape — clear graph selection
      if (e.key === "Escape" && graphSelectedNodeId) {
        setGraphSelectedNodeId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleToggleGraph, graphSelectedNodeId]);

  // ── Menu actions ──────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onMenuAction((action) => {
      switch (action) {
        case "save":
          editorGroupRef.current?.saveActiveEditor();
          break;
        case "exportMarkdown":
          setExportDialogOpen(true);
          break;
        case "importMarkdown":
          handleImportMarkdown();
          break;
      }
    });
    return unsub;
  }, [activeProject, activeDocumentFilename]);

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
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const content = await file.text();
      const suggestedFilename = file.name.replace(/\.[^.]+$/, "") + ".scholarpen.json";
      try {
        const blocks = await markdownToScholarBlocks(content);
        const created = await rpc.createDocument(activeProject!.path, suggestedFilename, blocks);
        await refreshFileTree();
        setActiveDocumentFilename(created);
        setCurrentView("editor");
      } catch (err) {
        console.error("Import failed:", err);
      }
    };
    input.click();
  }, [activeProject, refreshFileTree]);

  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!activeProject || !editorRef.current) return;
    const editor   = editorRef.current;
    const docName  = (activeDocumentFilename || "manuscript").replace(".scholarpen.json", "");
    const ext      = format === "qmd" ? ".qmd" : ".md";
    const markdown = await blocksToScholarMarkdown(editor, editor.document as any, format);
    await rpc.exportFile(activeProject.path, docName + ext, markdown);
    await refreshFileTree();
  }, [activeProject, activeDocumentFilename, refreshFileTree]);

  const handleImportFromFile = useCallback(async (filePath: string) => {
    if (!activeProject) return;
    try {
      const content  = await rpc.readTextFile(filePath);
      const blocks   = await markdownToScholarBlocks(content);
      const baseName = filePath.replace(/.*\//, "").replace(/\.[^.]+$/, "");
      const created  = await rpc.createDocument(activeProject.path, `${baseName}.scholarpen.json`, blocks);
      await refreshFileTree();
      setActiveDocumentFilename(created);
      setActiveFile(null);
      setCurrentView("editor");
    } catch (err) {
      console.error("Import from file failed:", err);
    }
  }, [activeProject, refreshFileTree]);

  const handleFileRenamed = useCallback((_newPath: string, _newName: string) => {}, []);

  const handleFileDeleted = useCallback(async (filePath: string) => {
    editorGroupRef.current?.closeFileByPath(filePath);
    await refreshFileTree();
  }, [refreshFileTree]);

  useEffect(() => {
    return onProjectUpdated((updatedPath) => {
      if (activeProject && updatedPath === activeProject.path)
        setEditorReloadTrigger(n => n + 1);
    });
  }, [activeProject]);

  // ── AI sidebar resize ─────────────────────────────────────────────────────

  const handleAIResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingAIRef.current = true;
    resizeAIStartRef.current = { x: e.clientX, width: aiSidebarWidth };
    const onMove = (ev: MouseEvent) => {
      if (!isResizingAIRef.current) return;
      const delta = resizeAIStartRef.current.x - ev.clientX;
      setAiSidebarWidth(Math.max(220, Math.min(640, resizeAIStartRef.current.width + delta)));
    };
    const onUp = () => {
      isResizingAIRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [aiSidebarWidth]);

  // ── Graph panel resize ────────────────────────────────────────────────────

  const handleGraphResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingGraphRef.current = true;
    resizeGraphStartRef.current = { x: e.clientX, width: graphPanelWidth };
    const onMove = (ev: MouseEvent) => {
      if (!isResizingGraphRef.current) return;
      const delta = ev.clientX - resizeGraphStartRef.current.x;
      setGraphPanelWidth(Math.max(280, Math.min(window.innerWidth * 0.75, resizeGraphStartRef.current.width + delta)));
    };
    const onUp = () => {
      isResizingGraphRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [graphPanelWidth]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 h-11 border-b border-border bg-background flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
            <PenLine className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-foreground tracking-tight">ScholarPen</span>
        </div>
        <div className="flex items-center gap-1" />
      </header>

      {/* 3-pane layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Sidebar (Files + Knowledge tabs) */}
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
          onExportDocument={() => setExportDialogOpen(true)}
          onImportFile={handleImportFromFile}
          onFileRenamed={handleFileRenamed}
          onFileDeleted={handleFileDeleted}
          onKnowledgeFileSelect={handleKnowledgeFileSelect}
          activeFilePath={activeFile?.path}
          graphMode={graphMode}
          graphLoading={graphLoading}
          onToggleGraph={handleToggleGraph}
        />

        {/* Center: Settings | Graph+Editor */}
        {currentView === "settings" ? (
          <SettingsPage
            ollamaStatus={ollamaStatus}
            onClose={() => setCurrentView("editor")}
            onSettingsSaved={refreshProjects}
          />
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* KB Graph panel (when active) */}
            {graphMode && kbGraph && (
              <>
                <div
                  style={{ width: graphPanelWidth }}
                  className="flex-shrink-0 h-full"
                >
                  <KnowledgeGraphPanel
                    graph={kbGraph}
                    selectedNodeId={graphSelectedNodeId}
                    onNodeClick={handleGraphNodeClick}
                    onClearSelection={() => setGraphSelectedNodeId(null)}
                  />
                </div>
                {/* Resize handle */}
                <div
                  className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
                  onMouseDown={handleGraphResizeMouseDown}
                />
              </>
            )}

            {/* Editor */}
            <EditorPaneGroup
              ref={editorGroupRef}
              project={activeProject}
              ollamaStatus={ollamaStatus}
              reloadTrigger={editorReloadTrigger}
              onActiveFileChange={(file, docFilename) => {
                setActiveFile(file);
                setActiveDocumentFilename(docFilename);
              }}
              onActiveEditorChange={handleEditorReady}
              onWordCountChange={setWordCount}
              onSaveStatusChange={setSaveStatus}
            />
          </div>
        )}

        {/* Right: AI Sidebar */}
        {aiSidebarOpen && (
          <>
            <div
              className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
              onMouseDown={handleAIResizeMouseDown}
            />
            <AISidebar
              project={activeProject}
              ollamaStatus={ollamaStatus}
              editor={editorRef.current}
              onClose={() => setAiSidebarOpen(false)}
              width={aiSidebarWidth}
            />
          </>
        )}
      </div>

      {/* Bottom: Status Bar */}
      <StatusBar
        ollamaStatus={ollamaStatus}
        wordCount={wordCount}
        onToggleAI={() => setAiSidebarOpen(v => !v)}
        saveStatus={saveStatus}
      />

      {/* Export Dialog */}
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        onExport={handleExport}
        documentName={(activeDocumentFilename || "manuscript").replace(".scholarpen.json", "")}
      />
    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Share2, MoreHorizontal, History, PenLine, Save, Download, Upload } from "lucide-react";
import { FileExplorer } from "./components/sidebar/FileExplorer";
import { EditorArea } from "./components/editor/EditorArea";
import { FileViewer } from "./components/editor/FileViewer";
import { AISidebar } from "./components/sidebar/AISidebar";
import { StatusBar } from "./components/editor/StatusBar";
import { ExportDialog } from "./components/editor/ExportDialog";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Button } from "./components/ui/button";
import { rpc, onMenuAction, onImportMarkdown } from "./rpc";
import { blocksToScholarMarkdown, type ExportFormat } from "./blocks/markdown-serializer";
import { markdownToScholarBlocks } from "./blocks/markdown-parser";
import type { OllamaStatus, ProjectInfo, FileNode } from "../shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

type AppView = "editor" | "settings";
type SaveStatus = "saved" | "saving" | "unsaved";

export function App() {
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    connected: false,
    models: [],
    activeModel: null,
  });
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeFile, setActiveFile] = useState<FileNode | null>(null);
  const [activeDocumentFilename, setActiveDocumentFilename] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>("editor");
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const editorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);

  // Poll Ollama status every 10s
  useEffect(() => {
    let cancelled = false;
    const checkStatus = async () => {
      try {
        const status = await rpc.getOllamaStatus();
        if (!cancelled) setOllamaStatus(status);
      } catch {
        if (!cancelled) setOllamaStatus({ connected: false, models: [], activeModel: null });
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const refreshProjects = useCallback(() => {
    rpc.listProjects().then(setProjects).catch(console.error);
  }, []);

  // Load projects on mount
  useEffect(() => {
    refreshProjects();
  }, []);

  const refreshFileTree = useCallback(async () => {
    if (!activeProject) return;
    try {
      const tree = await rpc.listProjectFiles(activeProject.path);
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to load file tree:", err);
      setFileTree([]);
    }
  }, [activeProject]);

  const handleProjectChange = useCallback(async (project: ProjectInfo) => {
    setActiveProject(project);
    setActiveFile(null);
    setActiveDocumentFilename(null);
    try {
      const tree = await rpc.listProjectFiles(project.path);
      setFileTree(tree);
      // Auto-select the first document in the tree
      const documentsDir = tree.find((n) => n.name === "documents" && n.isDirectory);
      if (documentsDir?.children?.length) {
        const firstDoc = documentsDir.children.find(
          (c) => c.kind === "document" && !c.isDirectory
        );
        if (firstDoc) {
          setActiveFile(firstDoc);
          setActiveDocumentFilename(firstDoc.name);
          setCurrentView("editor");
        }
      }
    } catch (err) {
      console.error("Failed to load file tree:", err);
      setFileTree([]);
    }
  }, []);

  const handleCreateProject = useCallback(async (name: string) => {
    const project = await rpc.createProject(name);
    setProjects((prev) => [project, ...prev]);
    await handleProjectChange(project);
  }, [handleProjectChange]);

  const handleFileSelect = useCallback((file: FileNode) => {
    if (file.isDirectory) return;
    setActiveFile(file);
    if (file.kind === "document") {
      setActiveDocumentFilename(file.name);
    } else {
      setActiveDocumentFilename(null);
    }
    setCurrentView("editor");
  }, []);

  const handleEditorReady = useCallback(
    (editor: BlockNoteEditor<any, any, any> | null) => {
      editorRef.current = editor;
    },
    []
  );

  // ── Menu action handler ──────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onMenuAction((action) => {
      switch (action) {
        case "save": {
          const saveNow = (editorRef.current as any)?.__scholarpenSaveNow;
          if (saveNow) saveNow();
          break;
        }
        case "exportMarkdown":
          setExportDialogOpen(true);
          break;
        case "importMarkdown":
          // Trigger import flow — file dialog is handled by Bun process
          // For now, use a simple file input approach
          handleImportMarkdown();
          break;
      }
    });
    return unsubscribe;
  }, [activeProject, activeDocumentFilename]);

  // ── Import markdown content handler ──────────────────────────
  useEffect(() => {
    const unsubscribe = onImportMarkdown(async (content, suggestedFilename) => {
      if (!activeProject || !editorRef.current) return;
      try {
        // Convert markdown to BlockNote blocks
        const blocks = await markdownToScholarBlocks(editorRef.current, content);

        // Create a new document file
        const safeFilename = suggestedFilename.endsWith(".scholarpen.json")
          ? suggestedFilename
          : suggestedFilename.replace(/\.md$|\.qmd$|\.txt$/, "") + ".scholarpen.json";
        const createdFilename = await rpc.createDocument(
          activeProject.path,
          safeFilename,
          blocks
        );

        // Refresh file tree and switch to the new document
        await refreshFileTree();
        setActiveDocumentFilename(createdFilename);
        setActiveFile(null); // Will be resolved from file tree
        setCurrentView("editor");
      } catch (err) {
        console.error("Import failed:", err);
      }
    });
    return unsubscribe;
  }, [activeProject, refreshFileTree]);

  // ── Import markdown (fallback for browser dev) ────────────────
  const handleImportMarkdown = useCallback(async () => {
    if (!activeProject || !editorRef.current) return;

    // Use a file input as fallback when Electrobun RPC is unavailable
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.qmd,.txt,.markdown";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const content = await file.text();
      const suggestedFilename = file.name.replace(/\.[^.]+$/, "") + ".scholarpen.json";
      try {
        const blocks = await markdownToScholarBlocks(editorRef.current!, content);
        const createdFilename = await rpc.createDocument(
          activeProject!.path,
          suggestedFilename,
          blocks
        );
        await refreshFileTree();
        setActiveDocumentFilename(createdFilename);
        setCurrentView("editor");
      } catch (err) {
        console.error("Import failed:", err);
      }
    };
    input.click();
  }, [activeProject, refreshFileTree]);

  // ── Export handler ────────────────────────────────────────────
  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!activeProject || !editorRef.current) return;
    const editor = editorRef.current;
    const docName = (activeDocumentFilename || "manuscript").replace(".scholarpen.json", "");
    const ext = format === "qmd" ? ".qmd" : ".md";
    const filename = docName + ext;

    const markdown = await blocksToScholarMarkdown(editor, editor.document as any, format);
    await rpc.exportFile(activeProject.path, filename, markdown);
    await refreshFileTree();
  }, [activeProject, activeDocumentFilename, refreshFileTree]);

  // ── Import from file (context menu) ────────────────────────────
  const handleImportFromFile = useCallback(async (filePath: string) => {
    if (!activeProject || !editorRef.current) return;
    try {
      const content = await rpc.readTextFile(filePath);
      const blocks = await markdownToScholarBlocks(editorRef.current, content);
      const baseName = filePath.replace(/.*\//, "").replace(/\.[^.]+$/, "");
      const createdFilename = await rpc.createDocument(
        activeProject.path,
        `${baseName}.scholarpen.json`,
        blocks
      );
      await refreshFileTree();
      setActiveDocumentFilename(createdFilename);
      setActiveFile(null);
      setCurrentView("editor");
    } catch (err) {
      console.error("Import from file failed:", err);
    }
  }, [activeProject, refreshFileTree]);

  // ── File renamed callback ──────────────────────────────────────
  const handleFileRenamed = useCallback((newPath: string, newName: string) => {
    if (newName.endsWith(".scholarpen.json")) {
      setActiveDocumentFilename(newName);
    }
  }, []);

  // ── File deleted callback ─────────────────────────────────────
  const handleFileDeleted = useCallback(async (filePath: string) => {
    // If the deleted file was the active document, switch to another
    if (activeDocumentFilename && filePath.endsWith(activeDocumentFilename)) {
      setActiveDocumentFilename(null);
      setActiveFile(null);
      // Try to select the first remaining document
      if (activeProject) {
        try {
          const tree = await rpc.listProjectFiles(activeProject.path);
          const docsDir = tree.find((n) => n.name === "documents" && n.isDirectory);
          const firstDoc = docsDir?.children?.find((c) => c.kind === "document" && !c.isDirectory);
          if (firstDoc) {
            setActiveFile(firstDoc);
            setActiveDocumentFilename(firstDoc.name);
          }
        } catch {}
      }
    } else if (activeFile?.path === filePath) {
      setActiveFile(null);
    }
  }, [activeDocumentFilename, activeFile, activeProject]);

  const editorProject = activeProject;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 h-11 border-b border-border bg-background flex-shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
            <PenLine className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-foreground tracking-tight">ScholarPen</span>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          {/* Save */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => {
              const saveNow = (editorRef.current as any)?.__scholarpenSaveNow;
              if (saveNow) saveNow();
            }}
            disabled={!activeProject}
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>

          {/* Export */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => setExportDialogOpen(true)}
            disabled={!activeProject || !activeDocumentFilename}
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>

          {/* Import */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={handleImportMarkdown}
            disabled={!activeProject}
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </Button>

          <div className="w-px h-4 bg-border mx-1" />
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <Share2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* 3-pane layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: File Explorer */}
        <FileExplorer
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
        />

        {/* Center: Editor, FileViewer, or Settings */}
        {currentView === "settings" ? (
          <SettingsPage
            ollamaStatus={ollamaStatus}
            onClose={() => setCurrentView("editor")}
            onSettingsSaved={refreshProjects}
          />
        ) : activeFile && activeFile.kind !== "document" ? (
          <FileViewer file={activeFile} />
        ) : (
          <EditorArea
            project={editorProject}
            documentFilename={activeDocumentFilename}
            ollamaStatus={ollamaStatus}
            onWordCountChange={setWordCount}
            onEditorReady={handleEditorReady}
            onSaveStatusChange={setSaveStatus}
          />
        )}

        {/* Right: AI Sidebar (toggle) */}
        {aiSidebarOpen && (
          <AISidebar
            project={activeProject}
            ollamaStatus={ollamaStatus}
            editor={editorRef.current}
            onClose={() => setAiSidebarOpen(false)}
          />
        )}
      </div>

      {/* Bottom: Status Bar */}
      <StatusBar
        ollamaStatus={ollamaStatus}
        wordCount={wordCount}
        onToggleAI={() => setAiSidebarOpen((v) => !v)}
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
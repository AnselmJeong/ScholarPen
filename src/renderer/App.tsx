import React, { useState, useEffect, useCallback, useRef } from "react";
import { Share2, MoreHorizontal, History, PenLine } from "lucide-react";
import { FileExplorer } from "./components/sidebar/FileExplorer";
import { EditorArea } from "./components/editor/EditorArea";
import { AISidebar } from "./components/sidebar/AISidebar";
import { StatusBar } from "./components/editor/StatusBar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Button } from "./components/ui/button";
import { rpc } from "./rpc";
import type { OllamaStatus, ProjectInfo, FileNode } from "../shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

type AppView = "editor" | "settings";

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
  const [currentView, setCurrentView] = useState<AppView>("editor");
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const editorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);

  // Poll Ollama status every 10s
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await rpc.getOllamaStatus();
        setOllamaStatus(status);
      } catch {
        setOllamaStatus({ connected: false, models: [], activeModel: null });
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Load projects on mount
  useEffect(() => {
    rpc.listProjects().then(setProjects).catch(console.error);
  }, []);

  const handleProjectChange = useCallback(async (project: ProjectInfo) => {
    setActiveProject(project);
    setActiveFile(null);
    try {
      const tree = await rpc.listProjectFiles(project.path);
      setFileTree(tree);
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
    // Only manuscripts open in the editor; other file types are for future views
    if (file.kind === "manuscript") {
      setCurrentView("editor");
    }
  }, []);

  const handleEditorReady = useCallback(
    (editor: BlockNoteEditor<any, any, any> | null) => {
      editorRef.current = editor;
    },
    []
  );

  // Derive the effective project for the editor from the active file's parent
  // For now, the editor still uses project-level load/save
  const editorProject = activeFile?.kind === "manuscript" ? activeProject : activeProject;

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
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <Share2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-4 bg-border mx-1" />
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
            <History className="h-3.5 w-3.5" />
            History
          </Button>
          <Button size="sm" className="h-7 text-xs">
            Publish
          </Button>
          <div className="ml-1 h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
            A
          </div>
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
        />

        {/* Center: Editor or Settings */}
        {currentView === "settings" ? (
          <SettingsPage
            ollamaStatus={ollamaStatus}
            onClose={() => setCurrentView("editor")}
          />
        ) : (
          <EditorArea
            project={editorProject}
            ollamaStatus={ollamaStatus}
            onWordCountChange={setWordCount}
            onEditorReady={handleEditorReady}
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
      />
    </div>
  );
}

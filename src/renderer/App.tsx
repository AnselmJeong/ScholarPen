import React, { useState, useEffect, useCallback, useRef } from "react";
import { ProjectSidebar } from "./components/sidebar/ProjectSidebar";
import { EditorArea } from "./components/editor/EditorArea";
import { AISidebar } from "./components/sidebar/AISidebar";
import { StatusBar } from "./components/editor/StatusBar";
import { rpc } from "./rpc";
import type { OllamaStatus, ProjectInfo } from "../shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

export function App() {
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    connected: false,
    models: [],
    activeModel: null,
  });
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const editorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);

  // Poll Ollama status every 10s
  useEffect(() => {
    const checkStatus = async () => {
      console.log("[App] Checking Ollama status...");
      try {
        const status = await rpc.getOllamaStatus();
        console.log("[App] Ollama status received:", status);
        setOllamaStatus(status);
      } catch (err) {
        console.error("[App] Failed to get Ollama status:", err);
        setOllamaStatus({ connected: false, models: [], activeModel: null });
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 10_000);
    return () => clearInterval(interval);
  }, []);

  const handleEditorReady = useCallback(
    (editor: BlockNoteEditor<any, any, any> | null) => {
      editorRef.current = editor;
    },
    []
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50">
      {/* 3-pane layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Project Sidebar */}
        <ProjectSidebar
          activeProject={activeProject}
          onProjectChange={setActiveProject}
        />

        {/* Center: Editor */}
        <EditorArea
          project={activeProject}
          ollamaStatus={ollamaStatus}
          onWordCountChange={setWordCount}
          onEditorReady={handleEditorReady}
        />

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

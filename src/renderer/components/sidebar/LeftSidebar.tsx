import React, { useState } from "react";
import { Files, BookOpen, Network, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileExplorer } from "./FileExplorer";
import { KnowledgeTree } from "./KnowledgeTree";
import type { ProjectInfo, FileNode } from "@shared/rpc-types";

type SidebarTab = "files" | "knowledge";

interface LeftSidebarProps {
  // FileExplorer props (passed through)
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  onProjectChange: (project: ProjectInfo) => void;
  onCreateProject: (name: string) => Promise<void>;
  fileTree: FileNode[];
  activeFile: FileNode | null;
  onFileSelect: (file: FileNode) => void;
  onOpenSettings: () => void;
  onRefreshTree: () => Promise<void>;
  onExportDocument: () => void;
  onImportFile: (filePath: string) => Promise<void>;
  onFileRenamed: (newPath: string, newName: string) => void;
  onFileDeleted: (filePath: string) => void;
  // Knowledge / graph props
  onKnowledgeFileSelect: (filePath: string, title?: string) => void;
  activeFilePath?: string;
  graphMode: boolean;
  graphLoading: boolean;
  onToggleGraph: () => void;
}

export function LeftSidebar({
  // FileExplorer passthrough
  projects,
  activeProject,
  onProjectChange,
  onCreateProject,
  fileTree,
  activeFile,
  onFileSelect,
  onOpenSettings,
  onRefreshTree,
  onExportDocument,
  onImportFile,
  onFileRenamed,
  onFileDeleted,
  // Knowledge
  onKnowledgeFileSelect,
  activeFilePath,
  graphMode,
  graphLoading,
  onToggleGraph,
}: LeftSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("files");

  return (
    <div className="w-full flex-shrink-0 flex flex-col h-full border-r border-sidebar-border bg-sidebar">
      {/* Tab bar */}
      <div className="flex border-b border-sidebar-border flex-shrink-0">
        <button
          onClick={() => setActiveTab("files")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2",
            activeTab === "files"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Files className="h-3.5 w-3.5" />
          Files
        </button>
        <button
          onClick={() => setActiveTab("knowledge")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2",
            activeTab === "knowledge"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <BookOpen className="h-3.5 w-3.5" />
          Knowledge
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "files" ? (
        // Render FileExplorer without its outer border/width (it manages its own)
        // We hide the outer div border since LeftSidebar owns the border
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden [&>div]:w-full [&>div]:border-r-0">
          <FileExplorer
            projects={projects}
            activeProject={activeProject}
            onProjectChange={onProjectChange}
            onCreateProject={onCreateProject}
            fileTree={fileTree}
            activeFile={activeFile}
            onFileSelect={onFileSelect}
            onOpenSettings={onOpenSettings}
            onRefreshTree={onRefreshTree}
            onExportDocument={onExportDocument}
            onImportFile={onImportFile}
            onFileRenamed={onFileRenamed}
            onFileDeleted={onFileDeleted}
          />
        </div>
      ) : (
        /* Knowledge tab */
        <div className="flex flex-col flex-1 min-h-0">
          {/* Knowledge tab header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Knowledge Base
            </span>
            <button
              onClick={onToggleGraph}
              disabled={graphLoading || !activeProject}
              title={graphMode ? "Close graph view" : "Open graph view"}
              className={cn(
                "p-1 rounded transition-colors",
                graphMode
                  ? "text-primary bg-primary/10 hover:bg-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
                "disabled:opacity-40 disabled:cursor-not-allowed"
              )}
            >
              {graphLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Network  className="h-3.5 w-3.5" />}
            </button>
          </div>

          {/* Node tree */}
          <KnowledgeTree
            projectPath={activeProject?.path ?? null}
            activeFilePath={activeFilePath}
            onFileSelect={onKnowledgeFileSelect}
          />
        </div>
      )}
    </div>
  );
}

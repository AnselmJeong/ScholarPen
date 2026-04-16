import React from "react";
import { Network, Loader2, PenLine, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileExplorer } from "./FileExplorer";
import { KnowledgeTree } from "./KnowledgeTree";
import type { ProjectInfo, FileNode } from "@shared/rpc-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Folder } from "lucide-react";

export type SidebarTab = "files" | "knowledge";

interface LeftSidebarProps {
  activeTab: SidebarTab;
  // FileExplorer props
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

/** Project header — shown at the top regardless of active tab */
function ProjectHeader({
  projects,
  activeProject,
  onProjectChange,
  onCreateProject,
}: {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  onProjectChange: (p: ProjectInfo) => void;
  onCreateProject: (name: string) => Promise<void>;
}) {
  return (
    <div className="flex-shrink-0 px-3 pt-4 pb-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--scholar-muted)" }}>
        Project
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 transition-colors text-left hover:opacity-90"
            style={{ background: "rgba(91,33,182,0.08)" }}
          >
            <div
              className="flex h-6 w-6 items-center justify-center rounded-md flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #5b21b6 0%, #4c1d95 100%)" }}
            >
              <PenLine className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="block truncate text-xs font-semibold" style={{ color: "var(--scholar-text)" }}>
                {activeProject?.name ?? "No project"}
              </span>
              {activeProject && (
                <span className="block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--scholar-muted)" }}>
                  Active Manuscript
                </span>
              )}
            </div>
            <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: "var(--scholar-muted)" }} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {projects.length > 0 && (
            <>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.path}
                  onClick={() => onProjectChange(p)}
                  className={cn(activeProject?.path === p.path && "bg-accent")}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function LeftSidebar({
  activeTab,
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
  onKnowledgeFileSelect,
  activeFilePath,
  graphMode,
  graphLoading,
  onToggleGraph,
}: LeftSidebarProps) {
  return (
    <div className="w-full flex-shrink-0 flex flex-col h-full bg-sidebar">
      {activeTab === "files" ? (
        /* Files tab: FileExplorer handles its own project header */
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
        /* Knowledge tab: project header + KB tree */
        <>
          <ProjectHeader
            projects={projects}
            activeProject={activeProject}
            onProjectChange={onProjectChange}
            onCreateProject={onCreateProject}
          />

          {/* KB section header */}
          <div className="flex items-center justify-between px-4 pb-2 flex-shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--scholar-muted)" }}>
              Knowledge Base
            </span>
            <button
              onClick={onToggleGraph}
              disabled={graphLoading || !activeProject}
              title={graphMode ? "Close graph view" : "Open graph view"}
              className={cn(
                "p-1 rounded-lg transition-colors",
                graphMode
                  ? "text-primary bg-primary/10 hover:bg-primary/20"
                  : "hover:bg-sidebar-accent",
                "disabled:opacity-40 disabled:cursor-not-allowed"
              )}
              style={!graphMode ? { color: "var(--scholar-muted)" } : undefined}
            >
              {graphLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Network className="h-3.5 w-3.5" />}
            </button>
          </div>

          <KnowledgeTree
            projectPath={activeProject?.path ?? null}
            activeFilePath={activeFilePath}
            onFileSelect={onKnowledgeFileSelect}
          />
        </>
      )}
    </div>
  );
}

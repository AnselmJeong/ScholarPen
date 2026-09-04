import React from "react";
import { FileExplorer } from "./FileExplorer";
import type { FileNode, ProjectInfo } from "@shared/rpc-types";

interface LeftSidebarProps {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  onProjectChange: (project: ProjectInfo) => void;
  onCreateProject: (name: string) => Promise<void>;
  fileTree: FileNode[];
  activeFile: FileNode | null;
  onFileSelect: (file: FileNode) => void;
  onOpenSettings: () => void;
  onRefreshTree: () => Promise<void>;
  onExportDocuments: (documents: FileNode[]) => void;
  onFindReplaceDocuments: () => void;
  onImportFile: (filePath: string) => Promise<void>;
  onFileRenamed: (newPath: string, newName: string) => void;
  onFileDeleted: (filePath: string) => void;
}

export function LeftSidebar(props: LeftSidebarProps) {
  return (
    <div className="w-full flex-shrink-0 flex flex-col h-full bg-sidebar">
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden [&>div]:w-full [&>div]:border-r-0">
        <FileExplorer {...props} />
      </div>
    </div>
  );
}

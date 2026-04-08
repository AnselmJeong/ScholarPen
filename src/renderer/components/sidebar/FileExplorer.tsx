import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  File,
  BookOpen,
  Image,
  FileJson,
  Plus,
  Search,
  Settings,
  HelpCircle,
  FolderOpen as FolderOpenIcon,
  PenLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rpc } from "../../rpc";
import type { ProjectInfo, FileNode } from "@shared/rpc-types";

interface FileExplorerProps {
  projects: ProjectInfo[];
  activeProject: ProjectInfo | null;
  onProjectChange: (project: ProjectInfo) => void;
  onCreateProject: (name: string) => Promise<void>;
  fileTree: FileNode[];
  activeFile: FileNode | null;
  onFileSelect: (file: FileNode) => void;
  onOpenSettings: () => void;
}

function FileIcon({ kind, isDirectory, isOpen }: { kind: FileNode["kind"]; isDirectory: boolean; isOpen?: boolean }) {
  if (isDirectory) {
    return isOpen
      ? <FolderOpen className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0" />
      : <Folder className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0" />;
  }
  switch (kind) {
    case "manuscript": return <FileJson className="h-3.5 w-3.5 text-primary flex-shrink-0" />;
    case "reference": return <BookOpen className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />;
    case "figure": return <Image className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />;
    case "pdf": return <FileText className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />;
    case "note": return <FileText className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />;
    default: return <File className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />;
  }
}

function displayName(node: FileNode): string {
  if (node.kind === "manuscript") return node.name.replace(".scholarpen.json", "");
  return node.name;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activeFile: FileNode | null;
  query: string;
  onFileSelect: (file: FileNode) => void;
}

function TreeNode({ node, depth, activeFile, query, onFileSelect }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0);
  const name = displayName(node);

  if (query && !name.toLowerCase().includes(query.toLowerCase()) && !node.isDirectory) {
    return null;
  }

  const isActive = !node.isDirectory && activeFile?.path === node.path;

  if (node.isDirectory) {
    const hasVisibleChildren = !query || node.children?.some(
      (c) => !c.isDirectory && displayName(c).toLowerCase().includes(query.toLowerCase())
    );
    if (query && !hasVisibleChildren) return null;

    return (
      <div>
        <button
          onClick={() => setIsOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-foreground hover:bg-sidebar-accent transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="flex-shrink-0 text-muted-foreground">
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
          <FileIcon kind="folder" isDirectory={true} isOpen={isOpen} />
          <span className="truncate text-xs font-medium">{name}</span>
        </button>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                query={query}
                onFileSelect={onFileSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileSelect(node)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-foreground hover:bg-sidebar-accent/60"
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <FileIcon kind={node.kind} isDirectory={false} />
      <span className="truncate text-xs">{name}</span>
    </button>
  );
}

export function FileExplorer({
  projects,
  activeProject,
  onProjectChange,
  onCreateProject,
  fileTree,
  activeFile,
  onFileSelect,
  onOpenSettings,
}: FileExplorerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (newProjectDialogOpen) {
      setTimeout(() => newProjectInputRef.current?.focus(), 50);
    }
  }, [newProjectDialogOpen]);

  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateProject(newProjectName.trim());
      setNewProjectName("");
      setNewProjectDialogOpen(false);
    } finally {
      setCreating(false);
    }
  }, [newProjectName, creating, onCreateProject]);

  const handleOpenFolder = useCallback(async () => {
    const folderPath = await rpc.openFolderDialog();
    if (!folderPath) return;
    try {
      const project = await rpc.openProjectByPath(folderPath);
      onProjectChange(project);
    } catch (err) {
      console.error("Failed to open project from folder:", err);
    }
  }, [onProjectChange]);

  return (
    <TooltipProvider delayDuration={500}>
      <div className="w-56 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col h-full select-none">
        {/* Project dropdown */}
        <div className="px-2 pt-3 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent transition-colors text-left">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/20 flex-shrink-0">
                  <PenLine className="h-3.5 w-3.5 text-primary" />
                </div>
                <span className="flex-1 truncate text-sm font-semibold text-foreground">
                  {activeProject?.name ?? "No project"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52 bg-white">
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
              <DropdownMenuItem onClick={handleOpenFolder}>
                <FolderOpenIcon className="h-3.5 w-3.5" />
                Open folder...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* New Project button */}
        <div className="px-2 pb-3">
          <Button
            size="sm"
            className="w-full gap-1.5 text-xs h-7"
            onClick={() => setNewProjectDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            NEW PROJECT
          </Button>
        </div>

        <Separator />

        {/* Explorer section */}
        <div className="flex flex-col flex-1 min-h-0 pt-2">
          <div className="px-3 pb-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Explorer
            </p>
          </div>

          {/* Search */}
          {activeProject && (
            <div className="px-2 pb-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-6 h-6 text-xs"
                />
              </div>
            </div>
          )}

          {/* File tree */}
          <ScrollArea className="flex-1 px-1">
            {!activeProject ? (
              <p className="text-xs text-muted-foreground px-3 py-4 text-center leading-relaxed">
                Create or open a project to get started
              </p>
            ) : fileTree.length === 0 ? (
              <p className="text-xs text-muted-foreground px-3 py-2">No files</p>
            ) : (
              <div className="py-1">
                {fileTree.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    activeFile={activeFile}
                    query={searchQuery}
                    onFileSelect={onFileSelect}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <Separator />

        {/* Bottom nav */}
        <div className="px-1 py-2 flex flex-col gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-xs text-muted-foreground h-7"
                onClick={onOpenSettings}
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">App Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-xs text-muted-foreground h-7"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                Help
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Help & Documentation</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* New Project Dialog */}
      <Dialog open={newProjectDialogOpen} onOpenChange={setNewProjectDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              ref={newProjectInputRef}
              placeholder="Project name..."
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateProject();
                if (e.key === "Escape") setNewProjectDialogOpen(false);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNewProjectDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreateProject}
              disabled={!newProjectName.trim() || creating}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

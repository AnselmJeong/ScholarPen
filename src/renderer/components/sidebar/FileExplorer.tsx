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
  Pencil,
  Trash2,
  Download,
  Upload,
  FilePlus,
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

// ── Context Menu ──────────────────────────────────────────────
interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

// ── Props ──────────────────────────────────────────────────────
interface FileExplorerProps {
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
}

// ── Icons ──────────────────────────────────────────────────────
function FileIcon({ kind, isDirectory, isOpen }: { kind: FileNode["kind"]; isDirectory: boolean; isOpen?: boolean }) {
  if (isDirectory) {
    return isOpen
      ? <FolderOpen className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0" />
      : <Folder className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0" />;
  }
  switch (kind) {
    case "document": return <FileJson className="h-3.5 w-3.5 text-primary flex-shrink-0" />;
    case "reference": return <BookOpen className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />;
    case "figure": return <Image className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />;
    case "pdf": return <FileText className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />;
    case "note": return <FileText className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />;
    case "export": return <File className="h-3.5 w-3.5 text-orange-400 flex-shrink-0" />;
    default: return <File className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />;
  }
}

function displayName(node: FileNode): string {
  if (node.kind === "document") return node.name.replace(".scholarpen.json", "");
  return node.name;
}

/** Recursively check if a node (or any of its descendants) matches the query */
function hasMatchingDescendant(node: FileNode, query: string): boolean {
  if (!node.isDirectory) {
    return displayName(node).toLowerCase().includes(query.toLowerCase());
  }
  return node.children?.some((child) => hasMatchingDescendant(child, query)) ?? false;
}

// ── TreeNode ───────────────────────────────────────────────────
interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activeFile: FileNode | null;
  query: string;
  onFileSelect: (file: FileNode) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  renamingNode: FileNode | null;
  onRenameSubmit: (node: FileNode, newName: string) => void;
  onRenameCancel: () => void;
}

function TreeNode({ node, depth, activeFile, query, onFileSelect, onContextMenu, renamingNode, onRenameSubmit, onRenameCancel }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const name = displayName(node);

  useEffect(() => {
    if (renamingNode?.path === node.path) {
      setRenameValue(displayName(node));
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [renamingNode, node.path, node.name]);

  // Hide web asset files that are not directly useful in the editor
  const HIDDEN_EXTS = new Set([".html", ".htm", ".css", ".js", ".map", ".gz"]);
  if (!node.isDirectory) {
    const dot = node.name.lastIndexOf(".");
    const ext = dot >= 0 ? node.name.slice(dot).toLowerCase() : "";
    if (HIDDEN_EXTS.has(ext)) return null;
  }

  if (query && !name.toLowerCase().includes(query.toLowerCase()) && !node.isDirectory) {
    return null;
  }

  const isActive = !node.isDirectory && activeFile?.path === node.path;

  if (node.isDirectory) {
    const hasVisibleChildren = !query || node.children?.some(
      (c) => hasMatchingDescendant(c, query)
    );
    if (query && !hasVisibleChildren) return null;

    return (
      <div>
        <button
          onClick={() => setIsOpen((v) => !v)}
          onContextMenu={(e) => onContextMenu(e, node)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-foreground hover:bg-sidebar-accent transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="flex-shrink-0 text-muted-foreground">
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
          <FileIcon kind="folder" isDirectory={true} isOpen={isOpen} />
          <span className="truncate text-xs font-medium">{name}</span>
        </button>
        {(isOpen || !!query) && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                query={query}
                onFileSelect={onFileSelect}
                onContextMenu={onContextMenu}
                renamingNode={renamingNode}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Inline rename
  if (renamingNode?.path === node.path) {
    return (
      <div
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileIcon kind={node.kind} isDirectory={false} />
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && renameValue.trim()) {
              onRenameSubmit(node, renameValue.trim());
            }
            if (e.key === "Escape") onRenameCancel();
            e.stopPropagation();
          }}
          onBlur={() => {
            if (renameValue.trim()) onRenameSubmit(node, renameValue.trim());
            else onRenameCancel();
          }}
          className="flex-1 text-xs bg-background text-foreground border border-blue-400 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileSelect(node)}
      onContextMenu={(e) => onContextMenu(e, node)}
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

// ── FileExplorer ──────────────────────────────────────────────
export function FileExplorer({
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
}: FileExplorerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newDocDialogOpen, setNewDocDialogOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [creating, setCreating] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingNode, setRenamingNode] = useState<FileNode | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  const newDocInputRef = useRef<HTMLInputElement>(null);

  // Focus inputs when dialogs open
  useEffect(() => {
    if (newProjectDialogOpen) setTimeout(() => newProjectInputRef.current?.focus(), 50);
  }, [newProjectDialogOpen]);
  useEffect(() => {
    if (newDocDialogOpen) setTimeout(() => newDocInputRef.current?.focus(), 50);
  }, [newDocDialogOpen]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenu]);

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

  const handleCreateDocument = useCallback(async () => {
    if (!newDocName.trim() || !activeProject || creating) return;
    setCreating(true);
    try {
      const filename = newDocName.trim().endsWith(".scholarpen.json")
        ? newDocName.trim()
        : `${newDocName.trim()}.scholarpen.json`;
      await rpc.createDocument(activeProject.path, filename);
      await onRefreshTree();
      // Select the new document
      const tree = await rpc.listProjectFiles(activeProject.path);
      const docsDir = tree.find((n) => n.name === "documents" && n.isDirectory);
      const newDoc = docsDir?.children?.find((c) => c.name === filename);
      if (newDoc) onFileSelect(newDoc);
      setNewDocName("");
      setNewDocDialogOpen(false);
    } catch (err) {
      console.error("Failed to create document:", err);
    } finally {
      setCreating(false);
    }
  }, [newDocName, activeProject, creating, onRefreshTree, onFileSelect]);

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

  // ── Context menu actions ─────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleRename = useCallback((node: FileNode) => {
    setContextMenu(null);
    setRenamingNode(node);
  }, []);

  const handleRenameSubmit = useCallback(async (node: FileNode, newName: string) => {
    setRenamingNode(null);
    try {
      const newPath = await rpc.renameFile(node.path, newName);
      await onRefreshTree();
      onFileRenamed(newPath, newName);
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [onRefreshTree, onFileRenamed]);

  const handleDelete = useCallback((node: FileNode) => {
    setContextMenu(null);
    setDeleteTarget(node);
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteConfirmOpen(false);
    try {
      await rpc.deleteFile(deleteTarget.path);
      await onRefreshTree();
      onFileDeleted(deleteTarget.path);
    } catch (err) {
      console.error("Delete failed:", err);
    }
    setDeleteTarget(null);
  }, [deleteTarget, onRefreshTree, onFileDeleted]);

  const handleImport = useCallback(async (node: FileNode) => {
    setContextMenu(null);
    try {
      await onImportFile(node.path);
    } catch (err) {
      console.error("Import failed:", err);
    }
  }, [onImportFile]);

  const handleExport = useCallback((node: FileNode) => {
    setContextMenu(null);
    onExportDocument();
  }, [onExportDocument]);

  // ── Context menu items ──────────────────────────────────
  const getContextMenuItems = (node: FileNode) => {
    const items: { label: string; icon: React.ReactNode; action: () => void; className?: string }[] = [];

    if (node.kind === "document") {
      items.push({ label: "Export...", icon: <Download className="h-3.5 w-3.5" />, action: () => handleExport(node) });
      items.push({ label: "Rename", icon: <Pencil className="h-3.5 w-3.5" />, action: () => handleRename(node) });
      items.push({ label: "Delete", icon: <Trash2 className="h-3.5 w-3.5 text-red-500" />, action: () => handleDelete(node), className: "text-red-600" });
    } else if (node.kind === "note") {
      const ext = node.name.slice(node.name.lastIndexOf(".")).toLowerCase();
      if ([".md", ".qmd", ".markdown"].includes(ext)) {
        items.push({ label: "Import as Document", icon: <Upload className="h-3.5 w-3.5" />, action: () => handleImport(node) });
      }
      items.push({ label: "Rename", icon: <Pencil className="h-3.5 w-3.5" />, action: () => handleRename(node) });
      items.push({ label: "Delete", icon: <Trash2 className="h-3.5 w-3.5 text-red-500" />, action: () => handleDelete(node), className: "text-red-600" });
    } else {
      items.push({ label: "Rename", icon: <Pencil className="h-3.5 w-3.5" />, action: () => handleRename(node) });
      items.push({ label: "Delete", icon: <Trash2 className="h-3.5 w-3.5 text-red-500" />, action: () => handleDelete(node), className: "text-red-600" });
    }

    return items;
  };

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
          <div className="px-3 pb-1.5 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Explorer
            </p>
            {activeProject && (
              <button
                onClick={() => setNewDocDialogOpen(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="New Document"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </button>
            )}
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
                    onContextMenu={handleContextMenu}
                    renamingNode={renamingNode}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={() => setRenamingNode(null)}
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

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-popover border border-border text-popover-foreground rounded-md shadow-lg py-1 min-w-[140px] !w-auto text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {getContextMenuItems(contextMenu.node).map((item, i) => (
            <button
              key={i}
              onClick={item.action}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 hover:bg-accent transition-colors text-left",
                item.className
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}

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

      {/* New Document Dialog */}
      <Dialog open={newDocDialogOpen} onOpenChange={setNewDocDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Document</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              ref={newDocInputRef}
              placeholder="Document name..."
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateDocument();
                if (e.key === "Escape") setNewDocDialogOpen(false);
              }}
            />
            <p className="text-xs text-muted-foreground mt-2">
              Will be saved as <span className="font-mono">{newDocName.trim() || "untitled"}.scholarpen.json</span>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNewDocDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreateDocument}
              disabled={!newDocName.trim() || creating}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete File</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to delete <span className="font-semibold text-foreground">{deleteTarget?.name}</span>?
            This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
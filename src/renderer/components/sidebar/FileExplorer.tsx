import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Check,
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
  ListChecks,
  Minus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import { AppDialog } from "@/components/ui/app-dialog";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { cn } from "@/lib/utils";
import { rpc } from "../../rpc";
import type { ProjectInfo, FileNode } from "@shared/rpc-types";
import {
  collectSelectableFiles, isImportableFile, isSelectableFile,
  selectablePathsWithin, toggleFileSelection, runFileBatch,
  type FileBatchResult,
} from "./file-selection";

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
  onExportDocuments: (documents: FileNode[]) => void;
  onFindReplaceDocuments: () => void;
  onImportFile: (filePath: string, openDocument?: boolean) => Promise<void>;
  onFileRenamed: (newPath: string, newName: string) => void;
  onDeleteFile: (filePath: string) => Promise<void>;
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
  /** Right-click actions for a row (Astryx ContextMenu). */
  menuItems: (node: FileNode) => ContextMenuOption[];
  renamingNode: FileNode | null;
  onRenameSubmit: (node: FileNode, newName: string) => void;
  onRenameCancel: () => void;
  selectionMode: boolean;
  selectedPaths: ReadonlySet<string>;
  onToggleSelection: (node: FileNode) => void;
}

function SelectionCheckbox({
  checked,
  mixed = false,
  label,
  onClick,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onClick: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked || mixed
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/50 bg-background text-transparent hover:border-primary",
      )}
    >
      {mixed ? <Minus className="h-2.5 w-2.5" /> : checked ? <Check className="h-2.5 w-2.5" /> : null}
    </button>
  );
}

function TreeNode({
  node,
  depth,
  activeFile,
  query,
  onFileSelect,
  menuItems,
  renamingNode,
  onRenameSubmit,
  onRenameCancel,
  selectionMode,
  selectedPaths,
  onToggleSelection,
}: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth === 0 && node.name === "documents");
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const name = displayName(node);
  useEffect(() => { if (node.isDirectory && activeFile?.path.startsWith(node.path + "/")) setIsOpen(true); }, [activeFile?.path, node.path, node.isDirectory]);

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
    const descendantPaths = selectablePathsWithin(node);
    const selectedDescendantCount = descendantPaths.filter((path) => selectedPaths.has(path)).length;
    const directoryChecked = descendantPaths.length > 0 && selectedDescendantCount === descendantPaths.length;
    const directoryMixed = selectedDescendantCount > 0 && !directoryChecked;

    return (
      <div>
        <ContextMenu items={menuItems(node)} label={`${name} actions`} size="sm" menuWidth={220}>
        <div
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-foreground hover:bg-sidebar-accent transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {selectionMode && descendantPaths.length > 0 && (
            <SelectionCheckbox
              checked={directoryChecked}
              mixed={directoryMixed}
              label={`${directoryChecked ? "Clear" : "Select"} files in ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSelection(node);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-expanded={isOpen}
          >
            <span className="flex-shrink-0 text-muted-foreground">
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </span>
            <FileIcon kind="folder" isDirectory={true} isOpen={isOpen} />
            <span className="truncate text-xs font-medium">{name}</span>
          </button>
        </div>
        </ContextMenu>
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
                menuItems={menuItems}
                renamingNode={renamingNode}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
                selectionMode={selectionMode}
                selectedPaths={selectedPaths}
                onToggleSelection={onToggleSelection}
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
    <ContextMenu items={menuItems(node)} label={`${name} actions`} size="sm" menuWidth={220}>
    <div
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
        isActive
          ? "font-medium bg-primary/10 text-primary shadow-[inset_2px_0_0_hsl(var(--primary))]"
          : "text-sidebar-foreground hover:bg-sidebar-accent"
      )}
      style={{
        paddingLeft: `${depth * 12 + 10}px`,
      }}
    >
      {selectionMode && isSelectableFile(node) && (
        <SelectionCheckbox
          checked={selectedPaths.has(node.path)}
          label={`${selectedPaths.has(node.path) ? "Clear" : "Select"} ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelection(node);
          }}
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (selectionMode && isSelectableFile(node)) {
            onToggleSelection(node);
            return;
          }
          onFileSelect(node);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-pressed={selectionMode && isSelectableFile(node) ? selectedPaths.has(node.path) : undefined}
      >
        <FileIcon kind={node.kind} isDirectory={false} />
        <span className="truncate">{name}</span>
      </button>
    </div>
    </ContextMenu>
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
  onExportDocuments,
  onFindReplaceDocuments,
  onImportFile,
  onFileRenamed,
  onDeleteFile,
}: FileExplorerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newDocDialogOpen, setNewDocDialogOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingNode, setRenamingNode] = useState<FileNode | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<FileNode[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const busyRef = useRef(false);
  const [batchResult, setBatchResult] = useState<{ action: string; result: FileBatchResult } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const selectableFiles = useMemo(() => collectSelectableFiles(fileTree), [fileTree]);
  const selectedFiles = useMemo(() => selectableFiles.filter(file => selectedPaths.has(file.path)), [selectableFiles, selectedPaths]);
  const selectedDocuments = selectedFiles.filter(file => file.kind === "document");
  const selectedImports = selectedFiles.filter(isImportableFile);


  useEffect(() => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
    setBatchResult(null);
    setDeleteConfirmOpen(false);
  }, [activeProject?.path]);

  useEffect(() => {
    const availablePaths = new Set(selectableFiles.map((document) => document.path));
    setSelectedPaths((current) => {
      const next = new Set([...current].filter((path) => availablePaths.has(path)));
      if (next.size === current.size && [...next].every((path) => current.has(path))) return current;
      return next;
    });
  }, [selectableFiles]);

  useEffect(() => {
    if (!selectionMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current || deleteConfirmOpen) return;
      setSelectionMode(false);
      setSelectedPaths(new Set());
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectionMode, deleteConfirmOpen]);

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
      const created = await rpc.createDocument(activeProject.path, filename);
      await onRefreshTree();
      // Select the new document
      const tree = await rpc.listProjectFiles(activeProject.path);
      const docsDir = tree.find((n) => n.name === "documents" && n.isDirectory);
      const newDoc = docsDir?.children?.find((c) => c.name === created);
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

  const handleRename = useCallback((node: FileNode) => {
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
    setDeleteTargets([node]);
    setDeleteConfirmOpen(true);
  }, []);

  const performBatch = useCallback(async (files: FileNode[], action: "Imported" | "Deleted", openDocument = false) => {
    if (busyRef.current || files.length === 0) return;
    busyRef.current = true;
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const result = await runFileBatch(files, file => action === "Deleted"
        ? onDeleteFile(file.path) : onImportFile(file.path, openDocument));
      setSelectedPaths(current => {
        const next = new Set(current);
        result.succeeded.forEach(file => next.delete(file.path));
        return next;
      });
      setBatchResult({ action, result });
      await onRefreshTree();
    } finally {
      busyRef.current = false;
      setBatchBusy(false);
    }
  }, [onDeleteFile, onImportFile, onRefreshTree]);

  const confirmDelete = useCallback(async () => {
    setDeleteConfirmOpen(false);
    await performBatch(deleteTargets, "Deleted");
    setDeleteTargets([]);
  }, [deleteTargets, performBatch]);

  const handleImport = useCallback(async (node: FileNode) => {
    await performBatch([node], "Imported", true);
  }, [performBatch]);

  const handleExport = useCallback((node: FileNode) => {
    onExportDocuments([node]);
  }, [onExportDocuments]);

  const handleToggleSelection = useCallback((node: FileNode) => {
    setSelectedPaths((current) => toggleFileSelection(current, node));
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
  }, []);

  const handleExportSelected = useCallback(() => {
    if (selectedDocuments.length === 0) return;
    onExportDocuments(selectedDocuments);
    exitSelectionMode();
  }, [exitSelectionMode, onExportDocuments, selectedDocuments]);

  const handleSelectAll = useCallback(() => {
    setSelectedPaths((current) => (
      current.size === selectableFiles.length
        ? new Set()
        : new Set(selectableFiles.map((document) => document.path))
    ));
  }, [selectableFiles]);

  const handleRefreshExplorer = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshTree();
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshTree, refreshing]);

  // ── Context menu items ──────────────────────────────────
  const getContextMenuItems = (node: FileNode): ContextMenuOption[] => {
    const rename: ContextMenuOption = { label: "Rename", icon: Pencil, onClick: () => handleRename(node) };
    const remove: ContextMenuOption = { label: "Delete", icon: Trash2, variant: "destructive", onClick: () => handleDelete(node) };
    const select: ContextMenuOption = { label: "Select files...", icon: ListChecks, onClick: () => {
      setSelectionMode(true);
      setSelectedPaths((current) => new Set([...current, node.path]));
    } };
    const items: ContextMenuOption[] = [];

    if (node.isDirectory && node.name === "documents") {
      items.push({ label: "Find & Replace in Documents...", icon: Search, onClick: () => onFindReplaceDocuments() }, { type: "divider" });
    }

    if (node.kind === "document") {
      items.push({ label: "Export...", icon: Download, onClick: () => handleExport(node) }, select, { type: "divider" }, rename, remove);
    } else if (isImportableFile(node) && [".md", ".qmd", ".markdown"].includes(node.name.slice(node.name.lastIndexOf(".")).toLowerCase())) {
      items.push({ label: "Import as Document", icon: Upload, onClick: () => handleImport(node) }, select, { type: "divider" }, rename, remove);
    } else {
      items.push(rename, remove);
    }

    return items;
  };

  return (
    <>
      <div inert={batchBusy} className="w-56 flex-shrink-0 bg-sidebar flex flex-col h-full select-none">
        {/* Project header */}
        <div className="px-3 pt-4 pb-2">
          <p className="workbench-section-label mb-2">
            Project
          </p>
          <DropdownMenu
            menuWidth={220}
            menuMaxHeight={420}
            items={[
              ...(projects.length > 0 ? [{
                type: "section" as const,
                title: "Projects",
                items: projects.map((p) => ({
                  label: p.name,
                  icon: Folder,
                  endContent: activeProject?.path === p.path ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> : undefined,
                  onClick: () => onProjectChange(p),
                })),
              }, { type: "divider" as const }] : []),
              { label: "Open folder...", icon: FolderOpenIcon, onClick: () => void handleOpenFolder() },
            ]}
            renderTrigger={(trigger) => (
              <button {...trigger} type="button" aria-label={`Project: ${activeProject?.name ?? "No project"}`}
                className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2 py-1.5 hover:border-input transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                <div className="flex h-6 w-6 items-center justify-center rounded flex-shrink-0 bg-muted text-muted-foreground">
                  <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {activeProject?.name ?? "No project"}
                  </span>
                  {activeProject && (
                    <span className="block font-mono-ui text-[10px] text-muted-foreground">
                      Active Manuscript
                    </span>
                  )}
                </div>
                <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            )}
          />
          <div className="mt-2">
            <AstryxButton label="New Project" variant="ghost" size="sm" width="100%"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => { setNewProjectName(""); setNewProjectDialogOpen(true); }} />
          </div>
        </div>


        {/* Explorer section */}
        <div className="flex flex-col flex-1 min-h-0 pt-1">
          <div className="px-3 pb-1.5 flex items-center justify-between">
            {selectionMode ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                <p className="workbench-section-label truncate !text-primary">
                  {selectedFiles.length} selected
                </p>
              </div>
            ) : (
              <p className="workbench-section-label">
                Explorer
              </p>
            )}
            {activeProject && (
              <div className="flex items-center">
                {selectableFiles.length > 0 && (
                  <AstryxButton
                    label={selectionMode ? "Cancel file selection" : "Select documents or Markdown files"}
                    tooltip={selectionMode ? "Cancel selection" : "Select documents or Markdown files"}
                    variant="ghost" size="sm" isIconOnly className="workbench-toggle" data-active={selectionMode || undefined}
                    icon={selectionMode ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />}
                    onClick={() => { if (selectionMode) exitSelectionMode(); else setSelectionMode(true); }}
                  />
                )}
                <AstryxButton label="Reload explorer" tooltip="Reload explorer" variant="ghost" size="sm" isIconOnly
                  isLoading={refreshing} icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={handleRefreshExplorer} />
                <AstryxButton label="New Document" tooltip="New Document" variant="ghost" size="sm" isIconOnly
                  icon={<FilePlus className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => setNewDocDialogOpen(true)} />
              </div>
            )}
          </div>

          {/* Search */}
          {activeProject && (
            <div className="px-2 pb-2">
              <TextInput label="Search files" isLabelHidden size="sm" type="search" startIcon={Search} placeholder="Search files..."
                value={searchQuery} onChange={setSearchQuery} hasClear />
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
                    menuItems={getContextMenuItems}
                    renamingNode={renamingNode}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={() => setRenamingNode(null)}
                    selectionMode={selectionMode}
                    selectedPaths={selectedPaths}
                    onToggleSelection={handleToggleSelection}
                  />
                ))}
              </div>
            )}
          </ScrollArea>

          {selectionMode && selectableFiles.length > 0 && (
            <div
              className="mx-2 mb-2 flex-shrink-0 rounded-xl border p-2 shadow-sm"
              style={{
                borderColor: "hsl(var(--primary) / 0.2)",
                background: "hsl(var(--sidebar-accent) / 0.35)",
              }}
            >
              <div className="mb-2 flex items-center justify-between px-0.5">
                <button
                  onClick={handleSelectAll}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {selectedFiles.length === selectableFiles.length
                    ? <Check className="h-3 w-3 text-primary" />
                    : <Square className="h-3 w-3" />}
                  {selectedFiles.length === selectableFiles.length ? "Clear all" : "Select all"}
                </button>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {selectedFiles.length}/{selectableFiles.length}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <AstryxButton size="sm" variant="primary" width="100%" isDisabled={selectedDocuments.length === 0} onClick={handleExportSelected}
                  icon={<Download className="h-3 w-3" aria-hidden="true" />}
                  label={`Export ${selectedDocuments.length || ""} ${selectedDocuments.length === 1 ? "section" : "sections"}`} />
                <AstryxButton size="sm" variant="secondary" width="100%" isDisabled={selectedImports.length === 0}
                  onClick={() => performBatch(selectedImports, "Imported")} icon={<Upload className="h-3 w-3" aria-hidden="true" />}
                  label={`Import ${selectedImports.length || ""} MD/QMD`} />
                <AstryxButton size="sm" variant="destructive" width="100%" isDisabled={selectedFiles.length === 0}
                  onClick={() => { setDeleteTargets(selectedFiles); setDeleteConfirmOpen(true); }} icon={<Trash2 className="h-3 w-3" aria-hidden="true" />}
                  label={`Delete ${selectedFiles.length || ""} files`} />
              </div>
            </div>
          )}
        </div>

        {batchBusy && <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">Processing files…</p>}
        {batchResult && <div role="status" className="px-3 pb-2 text-xs">
          <p>{batchResult.action} {batchResult.result.succeeded.length} file(s).</p>
          {batchResult.result.failed.map(({ file, error }) => <p key={file.path} className="mt-1 text-destructive break-words">{file.name}: {error}</p>)}
        </div>}
        {/* bottom padding */}
        <div className="py-2" />
      </div>

      {/* New Project Dialog */}
      <AppDialog isOpen={newProjectDialogOpen} onOpenChange={setNewProjectDialogOpen} title="New Project" width={400} purpose="form"
        footer={<>
          <AstryxButton label="Cancel" variant="secondary" onClick={() => setNewProjectDialogOpen(false)} />
          <AstryxButton label={creating ? "Creating..." : "Create"} variant="primary" isLoading={creating}
            isDisabled={!newProjectName.trim() || creating} onClick={handleCreateProject} />
        </>}>
        <TextInput label="Project name" isLabelHidden placeholder="Project name..." value={newProjectName}
          onChange={setNewProjectName} onEnter={handleCreateProject} hasAutoFocus />
      </AppDialog>

      {/* New Document Dialog */}
      <AppDialog isOpen={newDocDialogOpen} onOpenChange={setNewDocDialogOpen} title="New Document" width={400} purpose="form"
        footer={<>
          <AstryxButton label="Cancel" variant="secondary" onClick={() => setNewDocDialogOpen(false)} />
          <AstryxButton label={creating ? "Creating..." : "Create"} variant="primary" isLoading={creating}
            isDisabled={!newDocName.trim() || creating} onClick={handleCreateDocument} />
        </>}>
        <TextInput label="Document name" isLabelHidden placeholder="Document name..." value={newDocName}
          onChange={setNewDocName} onEnter={handleCreateDocument} hasAutoFocus />
        <Text type="supporting" display="block">
          Will be saved as <span className="font-mono-ui">{newDocName.trim() || "untitled"}.scholarpen.json</span>
        </Text>
      </AppDialog>

      {/* Delete Confirm Dialog */}
      <AppDialog isOpen={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen} title={`Delete ${deleteTargets.length} file(s)`} width={420}
        subtitle="Delete these files? This cannot be undone."
        footer={<>
          <AstryxButton label="Cancel" variant="secondary" onClick={() => setDeleteConfirmOpen(false)} />
          <AstryxButton label="Delete" variant="destructive" onClick={confirmDelete} />
        </>}>
        <ul className="max-h-48 space-y-1 overflow-y-auto break-all font-mono-ui text-xs text-muted-foreground">
          {deleteTargets.map(file => <li key={file.path}>{file.path.replace(`${activeProject?.path}/`, "")}</li>)}
        </ul>
      </AppDialog>
    </>
  );
}

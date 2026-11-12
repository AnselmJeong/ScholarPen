import React, { createContext, useContext, Suspense } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { FileNode, ProjectInfo } from "../../shared/rpc-types";
import { bundledUI } from "./catalog.generated";
import { useExtensions } from "./state";

/** Trusted React adapters only. External plugins cannot receive editor objects. */
export interface ExtensionWorkspace {
  project: ProjectInfo | null;
  editingProject: ProjectInfo | null;
  activeFile: FileNode | null;
  files: FileNode[];
  editor: BlockNoteEditor<any, any, any> | null;
  selectFile(file: FileNode): void;
  setFiles(files: FileNode[]): void;
  refreshFiles(): Promise<void>;
  reloadBibliography(): void;
}
export type ExtensionSlotName = "status" | "toolbar" | "dialogs" | "settings" | "project";
export interface ExtensionUIProps { slot: ExtensionSlotName; workspace: ExtensionWorkspace; projectPath?: string }
const Workspace = createContext<ExtensionWorkspace | null>(null);
export const ExtensionWorkspaceProvider = Workspace.Provider;
export function useExtensionWorkspace() { return useContext(Workspace); }

class ExtensionBoundary extends React.Component<{ name: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <span role="alert" className="text-xs text-amber-700">{this.props.name}: unavailable</span> : this.props.children; }
}

export function ExtensionSlot({ name, projectPath }: { name: ExtensionSlotName; projectPath?: string }) {
  const workspace = useExtensionWorkspace();
  const extensions = useExtensions();
  if (!workspace) return null;
  return <>{bundledUI.filter(entry => entry.slots.includes(name) && extensions.some(info => info.manifest.id === entry.id && info.enabled)).map(({ id, Component }) =>
    <ExtensionBoundary key={`${id}:${workspace.project?.path ?? ""}`} name={id}><Suspense fallback={null}><Component slot={name} workspace={workspace} projectPath={projectPath} /></Suspense></ExtensionBoundary>)}</>;
}

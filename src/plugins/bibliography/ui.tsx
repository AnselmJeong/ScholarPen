import React, { useCallback } from "react";
import { BookOpen } from "lucide-react";
import { ToolbarButton } from "../../renderer/components/ui/toolbar-button";
import { findBibliographyNode } from "../../renderer/utils/document-tree";
import { rpc } from "../../renderer/rpc";
import type { ExtensionUIProps } from "../../renderer/extensions/slots";
export default function BibliographyUI({ workspace }: ExtensionUIProps) {
  const { project: activeProject, editingProject: activeEditingProject, activeFile, selectFile: handleFileSelect, refreshFiles: refreshFileTree } = workspace;
  const handleShowReferences = useCallback(async () => {
    if (!activeEditingProject) return;
    try {
      // The canonical file may have been replaced by an external editor or a
      // cloud-sync client without producing a reliable fs.watch event. Refresh
      // both the tree metadata and the already-open viewer from disk.
      const latestTree = await rpc.listProjectFiles(activeEditingProject.path);
      await refreshFileTree();
      workspace.reloadBibliography();
      const bibliography = findBibliographyNode(latestTree);
      if (bibliography) handleFileSelect(bibliography);
    } catch (error) {
      console.error("Could not refresh references.bib:", error);
    }
  }, [activeEditingProject, handleFileSelect, refreshFileTree]);

  return <ToolbarButton label="Show references" icon={BookOpen} onClick={handleShowReferences}
    isDisabled={!activeProject} isActive={activeFile?.kind === "reference"} />;
}

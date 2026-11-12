import React, { useCallback } from "react";
import { BookOpen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../renderer/components/ui/tooltip";
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

  return <>
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleShowReferences}
                  disabled={!activeProject}
                  aria-label="Show references"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                    disabled:cursor-not-allowed disabled:opacity-30
                    ${activeFile?.kind === "reference"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                >
                  <BookOpen className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Show references</TooltipContent>
            </Tooltip>
          </TooltipProvider>

  </>;
}

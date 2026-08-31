import type { FileNode } from "@shared/rpc-types";

export function collectDocumentNodes(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "document" && !node.isDirectory) return [node];
    return node.children ? collectDocumentNodes(node.children) : [];
  });
}

export function findBibliographyNode(nodes: FileNode[]): FileNode | null {
  // Draft and resource folders can contain their own references.bib files.
  // They are not the bibliography used by ScholarPen's save/reload RPCs,
  // which always target exports/references.bib. Selecting one recursively
  // would therefore show one file initially and a different file after Reload.
  const exportsDirectory = nodes.find(
    (node) => node.isDirectory && node.name.toLowerCase() === "exports",
  );
  if (!exportsDirectory?.children) return null;

  return exportsDirectory.children.find(
    (node) =>
      !node.isDirectory
      && node.kind === "reference"
      && node.name.toLowerCase() === "references.bib",
  ) ?? null;
}

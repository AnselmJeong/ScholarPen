import type { FileNode } from "@shared/rpc-types";

export function collectDocumentNodes(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "document" && !node.isDirectory) return [node];
    return node.children ? collectDocumentNodes(node.children) : [];
  });
}

export function findBibliographyNode(nodes: FileNode[]): FileNode | null {
  for (const node of nodes) {
    if (
      !node.isDirectory
      && node.kind === "reference"
      && node.name.toLowerCase() === "references.bib"
    ) {
      return node;
    }

    if (node.children) {
      const bibliography = findBibliographyNode(node.children);
      if (bibliography) return bibliography;
    }
  }

  return null;
}

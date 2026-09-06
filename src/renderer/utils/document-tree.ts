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

/** Exact search boundary: only native documents beneath the project documents folder. */
export function collectSearchDocumentNodes(nodes: FileNode[], projectPath: string): FileNode[] {
  const prefix = `${projectPath.replace(/\/$/, "")}/documents/`;
  const folder = nodes.find((node) => node.isDirectory && node.path === prefix.slice(0, -1));
  if (!folder) return [];
  return collectDocumentNodes([folder]).filter((node) => {
    const relative = node.path.slice(prefix.length);
    return node.path.startsWith(prefix)
      && relative.endsWith(".scholarpen.json")
      && relative.split("/").every((part) => part && part !== "." && part !== "..");
  });
}

export function documentRelativeFilename(projectPath: string, filePath: string): string {
  return filePath.slice(`${projectPath.replace(/\/$/, "")}/documents/`.length);
}

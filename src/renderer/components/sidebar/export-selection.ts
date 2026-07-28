import type { FileNode } from "@shared/rpc-types";
import { collectDocumentNodes } from "../../utils/document-tree";

export { collectDocumentNodes } from "../../utils/document-tree";

export function documentPathsWithin(node: FileNode): string[] {
  if (node.kind === "document" && !node.isDirectory) return [node.path];
  return node.children ? collectDocumentNodes(node.children).map((document) => document.path) : [];
}

export function toggleDocumentSelection(
  selectedPaths: ReadonlySet<string>,
  node: FileNode,
): Set<string> {
  const next = new Set(selectedPaths);
  const paths = documentPathsWithin(node);
  const shouldSelect = paths.some((path) => !next.has(path));

  for (const path of paths) {
    if (shouldSelect) next.add(path);
    else next.delete(path);
  }

  return next;
}

export function selectedDocumentNodes(
  nodes: FileNode[],
  selectedPaths: ReadonlySet<string>,
): FileNode[] {
  return collectDocumentNodes(nodes).filter((node) => selectedPaths.has(node.path));
}

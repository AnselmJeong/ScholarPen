import type { FileNode } from "@shared/rpc-types";

export function collectDocumentNodes(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "document" && !node.isDirectory) return [node];
    return node.children ? collectDocumentNodes(node.children) : [];
  });
}

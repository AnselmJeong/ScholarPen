import type { FileNode } from "@shared/rpc-types";

export function isImportableFile(node: FileNode): boolean {
  return !node.isDirectory && /\.(md|qmd|markdown)$/i.test(node.name);
}

export function isSelectableFile(node: FileNode): boolean {
  return !node.isDirectory && (node.kind === "document" || isImportableFile(node));
}

export function collectSelectableFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => isSelectableFile(node)
    ? [node] : node.isDirectory ? collectSelectableFiles(node.children ?? []) : []);
}

export function selectablePathsWithin(node: FileNode): string[] {
  return collectSelectableFiles([node]).map((file) => file.path);
}

export function toggleFileSelection(selected: ReadonlySet<string>, node: FileNode): Set<string> {
  const next = new Set(selected);
  const paths = selectablePathsWithin(node);
  const add = paths.some((path) => !next.has(path));
  for (const path of paths) add ? next.add(path) : next.delete(path);
  return next;
}

export interface FileBatchResult {
  succeeded: FileNode[];
  failed: Array<{ file: FileNode; error: string }>;
}

/** Preserve order, continue after individual failures, and report exact outcomes. */
export async function runFileBatch(
  files: FileNode[],
  action: (file: FileNode) => Promise<void>,
): Promise<FileBatchResult> {
  const result: FileBatchResult = { succeeded: [], failed: [] };
  for (const file of files) {
    try {
      await action(file);
      result.succeeded.push(file);
    } catch (error) {
      result.failed.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

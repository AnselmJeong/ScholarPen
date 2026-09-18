import { collectReferenceTargets, normalizeQuartoBlocks, type ReferenceBlock, type ReferenceTarget } from "./quarto-references";

export interface ReferenceDocument {
  filename: string;
  targets: ReferenceTarget[];
  error?: string;
}
export interface ProjectReferenceTarget extends ReferenceTarget { filename: string }

export function documentReferenceTargets(content: unknown): ReferenceTarget[] {
  function validBlocks(value: unknown): value is ReferenceBlock[] {
    return Array.isArray(value) && value.every((block) => block && typeof block === "object"
      && typeof block.type === "string" && (block.children === undefined || validBlocks(block.children)));
  }
  if (!validBlocks(content)) throw new Error("Invalid document content");
  return collectReferenceTargets(normalizeQuartoBlocks(content));
}

/** A live document replaces its whole saved index, including removed labels. */
export function mergeProjectReferences(
  saved: ReferenceDocument[], projectPath: string, snapshots: Map<string, unknown[]>,
  activeFilename: string, activeBlocks: ReferenceBlock[],
): { targets: ProjectReferenceTarget[]; errors: string[] } {
  const documents = new Map(saved.map((document) => [document.filename, document]));
  const prefix = `${projectPath.replace(/\/$/, "")}/documents/`;
  for (const [path, blocks] of snapshots) {
    if (!path.startsWith(prefix)) continue;
    const filename = path.slice(prefix.length);
    if (!filename.endsWith(".scholarpen.json") || filename.split("/").some((part) => !part || part === ".." || part === ".")) continue;
    // A removed/renamed file may still have an old tab open. Do not resurrect it.
    if (!documents.has(filename)) continue;
    documents.set(filename, { filename, targets: documentReferenceTargets(blocks) });
  }
  documents.set(activeFilename, { filename: activeFilename, targets: documentReferenceTargets(activeBlocks) });
  const ordered = [...documents.values()].sort((a, b) =>
    Number(b.filename === activeFilename) - Number(a.filename === activeFilename) || a.filename.localeCompare(b.filename));
  return {
    targets: ordered.flatMap(({ filename, targets }) => targets.map((target) => ({ ...target, filename }))),
    errors: ordered.filter((document) => document.error).map((document) => document.filename),
  };
}

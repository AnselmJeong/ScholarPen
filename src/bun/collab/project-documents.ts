import { relative, sep } from "node:path";
import type { FileNode } from "../../shared/rpc-types";
import { documentReferenceTargets } from "../../shared/project-references";
import { blockNoteText, inlineText } from "./agent/bulk-sources";

export interface DocumentParagraph { blockId: string; kind: string; text: string }

/** A saved project document, read for project-wide checks and the manuscript map. */
export interface ProjectDocument {
  /** Relative to `documents/`, like a collab session's filename. */
  filename: string;
  text: string;
  paragraphs: DocumentParagraph[];
  /** Cross-references (`@fig-…`, `@sec-…`) used in the text. */
  references: Array<{ blockId: string; label: string }>;
  /** Labels this document defines. */
  labels: string[];
  error?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectReferences(content: unknown, blockId: string, out: ProjectDocument["references"]) {
  if (Array.isArray(content)) { for (const item of content) collectReferences(item, blockId, out); return; }
  if (!record(content)) return;
  if (content.type === "crossReference" && record(content.props) && typeof content.props.label === "string" && content.props.label) {
    out.push({ blockId, label: content.props.label });
  }
  if (content.content) collectReferences(content.content, blockId, out);
}

/** Paragraphs, references and labels of a saved BlockNote document. */
export function documentStructure(filename: string, content: unknown): ProjectDocument {
  const paragraphs: DocumentParagraph[] = [];
  const references: ProjectDocument["references"] = [];
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!record(block)) continue;
      const blockId = typeof block.id === "string" ? block.id : "";
      if (Array.isArray(block.content)) {
        const text = inlineText(block.content).trim();
        if (text && blockId) paragraphs.push({ blockId, kind: String(block.type ?? "paragraph"), text });
        collectReferences(block.content, blockId, references);
      }
      walk(block.children);
    }
  };
  walk(content);
  let labels: string[] = [];
  try { labels = documentReferenceTargets(content).map(target => target.label); }
  catch { /* An invalid document has no usable labels; its text is still checked. */ }
  return { filename, text: blockNoteText(content), paragraphs, references, labels };
}

function flatten(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap(node => node.isDirectory ? flatten(node.children ?? []) : [node]);
}

/** Every `documents/**\/*.scholarpen.json` of a project, in path order. Unreadable files are reported, not skipped. */
export async function loadProjectDocuments(projectPath: string): Promise<ProjectDocument[]> {
  const { fileSystem } = await import("../fs/manager");
  const root = await fileSystem.resolveProjectPath(projectPath);
  const files = flatten(await fileSystem.listProjectFiles(root, 0, Number.POSITIVE_INFINITY))
    .map(file => ({ file, path: relative(root, file.path).split(sep).join("/") }))
    .filter(({ path }) => path.startsWith("documents/") && path.endsWith(".scholarpen.json"))
    .sort((a, b) => a.path.localeCompare(b.path));
  const documents: ProjectDocument[] = [];
  for (const { file, path } of files) {
    const filename = path.slice("documents/".length);
    try {
      documents.push(documentStructure(filename, JSON.parse(await fileSystem.readTextFile(file.path))));
    } catch (error) {
      documents.push({ filename, text: "", paragraphs: [], references: [], labels: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return documents;
}

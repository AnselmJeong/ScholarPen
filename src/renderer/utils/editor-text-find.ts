import type { Node as PMNode } from "prosemirror-model";
import { buildSnippet, occurrenceOffsets } from "./document-text-replace";
import { searchAnnotationText } from "./search-annotation";

export interface EditorTextMatch {
  kind: "text" | "annotation";
  from: number;
  to: number;
  snippet: string;
  snippetOffset: number;
}

export interface DocumentFindRequest {
  id: string;
  filePath: string;
  filename: string;
  searchTerm: string;
  matchIndex: number;
  scope: "document" | "project";
}

export function findEditorTextMatches(doc: PMNode, term: string): EditorTextMatch[] {
  if (!term) return [];
  const matches: EditorTextMatch[] = [];
  const findAnnotation = (node: PMNode, pos: number) => {
    const text = searchAnnotationText(node.type.name, node.attrs);
    for (const offset of occurrenceOffsets(text, term)) {
      matches.push({ kind: "annotation", from: pos, to: pos + node.nodeSize,
        ...buildSnippet(text, offset, term.length) });
    }
  };
  doc.descendants((node, pos) => {
    findAnnotation(node, pos);
    if (!node.isTextblock) return;
    let text = "";
    let start = pos + 1;
    const flush = () => {
      for (const offset of occurrenceOffsets(text, term)) {
        matches.push({
          kind: "text",
          from: start + offset,
          to: start + offset + term.length,
          ...buildSnippet(text, offset, term.length),
        });
      }
      text = "";
    };
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text;
      } else {
        flush();
        findAnnotation(child, pos + 1 + offset);
      }
    });
    flush();
    return false;
  });
  return matches;
}

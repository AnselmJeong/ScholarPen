import type { Node as PMNode } from "prosemirror-model";
import { buildSnippet, occurrenceOffsets } from "./document-text-replace";

export interface EditorTextMatch {
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
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    let text = "";
    let start = pos + 1;
    const flush = () => {
      for (const offset of occurrenceOffsets(text, term)) {
        matches.push({
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
      } else flush();
    });
    flush();
    return false;
  });
  return matches;
}

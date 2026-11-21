import type { ActiveDocumentContext } from "./rpc-types";
import { manuscriptText } from "./manuscript-text";

export const ACTIVE_DOCUMENT_LIMIT = 50_000;

/**
 * The live document as readable text (citations, tables, math and nesting
 * kept; no image bytes). Block JSON was mostly markup: a results section with
 * twelve tables took 160,000 characters for 27,000 of text, and lost its
 * middle to the limit above.
 */
export function snapshotActiveDocument(path: string, blocks: unknown[]): ActiveDocumentContext {
  return boundActiveDocument({ path, content: manuscriptText(blocks), truncated: false });
}

export function boundActiveDocument(document: ActiveDocumentContext): ActiveDocumentContext {
  if (document.content.length <= ACTIVE_DOCUMENT_LIMIT) return { ...document };
  const marker = "\n[...active document truncated...]\n";
  const head = Math.floor((ACTIVE_DOCUMENT_LIMIT - marker.length) * 0.7);
  const tail = ACTIVE_DOCUMENT_LIMIT - marker.length - head;
  return { path: document.path, content: document.content.slice(0, head) + marker + document.content.slice(-tail), truncated: true };
}

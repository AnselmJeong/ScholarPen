import type { ActiveDocumentContext } from "./rpc-types";

export const ACTIVE_DOCUMENT_LIMIT = 50_000;

/** Preserve structured citations, tables, math and nested blocks, without image bytes. */
export function snapshotActiveDocument(path: string, blocks: unknown[]): ActiveDocumentContext {
  const content = JSON.stringify(blocks, (key, value: unknown) => {
    if (key === "id" || key === "styles") return undefined;
    if (typeof value === "string" && value.startsWith("data:")) return "[embedded media]";
    return value;
  });
  return boundActiveDocument({ path, content, truncated: false });
}

export function boundActiveDocument(document: ActiveDocumentContext): ActiveDocumentContext {
  if (document.content.length <= ACTIVE_DOCUMENT_LIMIT) return { ...document };
  const marker = "\n[...active document truncated...]\n";
  const head = Math.floor((ACTIVE_DOCUMENT_LIMIT - marker.length) * 0.7);
  const tail = ACTIVE_DOCUMENT_LIMIT - marker.length - head;
  return { path: document.path, content: document.content.slice(0, head) + marker + document.content.slice(-tail), truncated: true };
}

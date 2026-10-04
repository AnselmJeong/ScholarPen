import type { SchemaSpecJSON } from "./schema-spec";

// Shared Y.Doc layout. Every peer (each open editor, the Bun AI agent) agrees on these names.
export const COLLAB_FRAGMENT = "document-store";
export const COLLAB_THREADS_MAP = "threads";

/** Peer id used as the Yjs transaction origin for Bun-originated changes. */
export const BUN_PEER_ID = "bun";

export function collabDocKey(projectPath: string, filename: string) {
  return `${projectPath}::${filename}`;
}

export interface CollabOpenParams {
  projectPath: string;
  filename: string;
  peerId: string;
  schema: SchemaSpecJSON;
}

export interface CollabOpenResult {
  docKey: string;
  /** Full Y.Doc state as a base64-encoded update. */
  state: string;
  /** Current awareness states of the other peers, base64-encoded. */
  awareness: string | null;
  /**
   * "seed": the Y.Doc is empty and this peer must import the JSON document.
   * "reconcile": the JSON file changed outside the editor; merge it in block by block.
   * "none": the Y.Doc is authoritative.
   */
  bootstrap: "seed" | "reconcile" | "none";
}

export interface CollabUpdateMessage {
  docKey: string;
  /** Peer that produced the update; receivers skip their own echoes. */
  origin: string;
  update: string;
}

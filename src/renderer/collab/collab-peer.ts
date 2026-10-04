import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { fromBase64, toBase64 } from "lib0/buffer";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { CommentsExtension, DefaultThreadStoreAuth, YjsThreadStore } from "@blocknote/core/comments";
import { rpc, onCollabAwareness, onCollabUpdate } from "../rpc";
import { scholarSchema } from "../blocks/schema";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP, type CollabOpenResult } from "../../shared/collab/protocol";
import { LOCAL_USER_ID } from "../../shared/collab/threads";
import { schemaToSpecJSON, type SchemaSpecJSON } from "../../shared/collab/schema-spec";
import { normalizeQuartoBlocks } from "../../shared/quarto-references";

/** Transaction origin for changes that arrived from Bun, so they are never echoed back. */
const REMOTE = Symbol("collab-remote");

export interface CollabPeer {
  docKey: string;
  peerId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  threadStore: YjsThreadStore;
  bootstrap: CollabOpenResult["bootstrap"];
  snapshotStale: boolean;
  destroy(): void;
}

let headlessEditor: BlockNoteEditor<any, any, any> | null = null;
/**
 * An unmounted editor with the same schema as the real ones, including the
 * comment mark that only exists when the comments extension is loaded.
 */
export function getHeadlessEditor() {
  headlessEditor ??= BlockNoteEditor.create({
    schema: scholarSchema,
    extensions: [CommentsExtension({
      threadStore: new YjsThreadStore(LOCAL_USER_ID, new Y.Doc().getMap(COLLAB_THREADS_MAP),
        new DefaultThreadStoreAuth(LOCAL_USER_ID, "editor")),
      resolveUsers: async () => [],
    })],
  });
  return headlessEditor;
}

let schemaSpec: SchemaSpecJSON | null = null;
function getSchemaSpec() {
  schemaSpec ??= schemaToSpecJSON(getHeadlessEditor().pmSchema);
  return schemaSpec;
}

export function normalizeDocumentContent(content: unknown) {
  if (Array.isArray(content) && content.length > 0) return normalizeQuartoBlocks(content);
  return [{ type: "paragraph", content: "" }];
}

const localPeers = new Map<string, Set<{ peerId: string; ydoc: Y.Doc; awareness: Awareness }>>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onCollabUpdate(({ docKey, origin, update }) => {
    for (const peer of localPeers.get(docKey) ?? []) {
      if (peer.peerId !== origin) Y.applyUpdate(peer.ydoc, fromBase64(update), REMOTE);
    }
  });
  onCollabAwareness(({ docKey, origin, update }) => {
    for (const peer of localPeers.get(docKey) ?? []) {
      if (peer.peerId !== origin) applyAwarenessUpdate(peer.awareness, fromBase64(update), REMOTE);
    }
  });
}

/**
 * Opens one editor's peer of the shared document. The returned Y.Doc already
 * holds the full state, so the editor can mount on it without an empty flash.
 */
export async function openCollabPeer(projectPath: string, filename: string): Promise<CollabPeer> {
  listen();
  const peerId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const opened = await rpc.collabOpen({ projectPath, filename, peerId, schema: getSchemaSpec() });
  const { docKey } = opened;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, fromBase64(opened.state), REMOTE);
  const awareness = new Awareness(ydoc);
  if (opened.awareness) applyAwarenessUpdate(awareness, fromBase64(opened.awareness), REMOTE);

  // Batch local updates per task so a burst of keystrokes is one RPC.
  let pending: Uint8Array[] = [];
  let pushChain = Promise.resolve();
  const flush = () => {
    if (pending.length === 0) return;
    const merged = Y.mergeUpdates(pending);
    pending = [];
    pushChain = pushChain
      .then(() => rpc.collabPush(docKey, peerId, toBase64(merged)))
      .catch((error) => console.error("[collab] push failed", error));
  };
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    if (pending.length === 0) queueMicrotask(flush);
    pending.push(update);
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === REMOTE) return;
    const changed = [...added, ...updated, ...removed].filter((id) => id === ydoc.clientID);
    if (changed.length === 0) return;
    void rpc.collabAwareness(docKey, peerId, toBase64(encodeAwarenessUpdate(awareness, changed)))
      .catch(() => undefined);
  });

  const entry = { peerId, ydoc, awareness };
  const peers = localPeers.get(docKey) ?? new Set();
  peers.add(entry);
  localPeers.set(docKey, peers);

  if (opened.bootstrap === "seed") {
    let content: unknown = [];
    try { content = await rpc.loadDocument(projectPath, filename); }
    catch (error) { console.warn("[collab] seeding from an empty document", error); }
    blocksToYXmlFragment(
      getHeadlessEditor(),
      normalizeDocumentContent(content) as any,
      ydoc.getXmlFragment(COLLAB_FRAGMENT),
    );
    flush();
  }

  const threadStore = new YjsThreadStore(
    LOCAL_USER_ID,
    ydoc.getMap(COLLAB_THREADS_MAP),
    new DefaultThreadStoreAuth(LOCAL_USER_ID, "editor"),
  );

  let destroyed = false;
  return {
    docKey,
    peerId,
    ydoc,
    awareness,
    threadStore,
    bootstrap: opened.bootstrap,
    snapshotStale: opened.snapshotStale,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      flush();
      removeAwarenessStates(awareness, [ydoc.clientID], "local");
      peers.delete(entry);
      if (peers.size === 0) localPeers.delete(docKey);
      void pushChain.finally(() => rpc.collabClose(docKey, peerId).catch(() => undefined));
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

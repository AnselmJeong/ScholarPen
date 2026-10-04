import type { BlockNoteEditor } from "@blocknote/core";
import type { CollabPeer } from "./collab-peer";

const peers = new WeakMap<BlockNoteEditor<any, any, any>, CollabPeer>();

/** Associates a mounted editor with its peer of the shared Y.Doc. */
export function setEditorCollab(editor: BlockNoteEditor<any, any, any>, peer: CollabPeer | null) {
  if (peer) peers.set(editor, peer);
  else peers.delete(editor);
}

export function getEditorCollab(editor: BlockNoteEditor<any, any, any>) {
  return peers.get(editor) ?? null;
}

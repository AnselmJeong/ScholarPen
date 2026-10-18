import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import { COLLAB_FRAGMENT } from "../../../shared/collab/protocol";

export type DeleteSet = Y.Transaction["deleteSet"];

/** A delete set exactly as Yjs writes it at the end of a v1 update. */
function encodeDeleteSet(ds: DeleteSet) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, ds.clients.size);
  for (const [client, items] of [...ds.clients.entries()].sort((a, b) => b[0] - a[0])) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, items.length);
    for (const item of items) {
      encoding.writeVarUint(encoder, item.clock);
      encoding.writeVarUint(encoder, item.len);
    }
  }
  return encoding.toUint8Array(encoder);
}

function endsWith(bytes: Uint8Array, suffix: Uint8Array) {
  if (suffix.length > bytes.length) return false;
  const offset = bytes.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) if (bytes[offset + i] !== suffix[i]) return false;
  return true;
}

/**
 * Everything the document gained since the state vector `since`: the new
 * structs as they are now (content inserted and deleted again in between is
 * already garbage-collected) plus only the deletions made since then. A plain
 * `encodeStateAsUpdate(doc, since)` would repeat the document's whole delete
 * set in every checkpoint.
 */
export function encodeCheckpoint(doc: Y.Doc, since: Uint8Array, deletions: DeleteSet) {
  const full = Y.encodeStateAsUpdate(doc, since);
  const fullDeletes = encodeDeleteSet(Y.createDeleteSetFromStructStore(doc.store));
  // Pending structs change the layout; then keep the whole delete set.
  if (!endsWith(full, fullDeletes)) return full;
  const structs = full.subarray(0, full.length - fullDeletes.length);
  const newDeletes = encodeDeleteSet(deletions);
  const out = new Uint8Array(structs.length + newDeletes.length);
  out.set(structs, 0);
  out.set(newDeletes, structs.length);
  return out;
}

/** True when state vector `a` has seen everything `b` has. */
export function covers(a: Map<number, number>, b: Map<number, number>) {
  for (const [client, clock] of b) if ((a.get(client) ?? 0) < clock) return false;
  return true;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && endsWith(a, b);
}

/** The document with pending AI suggestions left out, as the JSON snapshot and export see it. */
export function acceptedDoc(doc: PMNode, schema: Schema) {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.marks.some((mark) => ["insertion", "deletion", "modification"].includes(mark.type.name))) found = true;
    return !found;
  });
  if (!found) return doc;
  let out = doc;
  revertSuggestions(EditorState.create({ schema, doc }), (tr) => { out = tr.doc; });
  return out;
}

export function readFragment(ydoc: Y.Doc, schema: Schema) {
  return acceptedDoc(yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(COLLAB_FRAGMENT), schema), schema);
}

/** Replays checkpoints, oldest first, into a fresh Y.Doc and reads the document they add up to. */
export function readVersion(updates: Uint8Array[], schema: Schema) {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, Y.mergeUpdates(updates));
    return readFragment(ydoc, schema);
  } finally {
    ydoc.destroy();
  }
}

import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { transformToSuggestionTransaction } from "@handlewithcare/prosemirror-suggest-changes";
import {
  hasProtectedTextChanges,
  protectSelectionSlice,
  protectedRewritePreview,
  restoreProtectedSelection,
  type ProtectedSelection,
} from "../../../shared/ai-text-protection";
import type { CollabSession } from "../registry";
import {
  blockContent,
  blockFingerprint,
  findBlock,
  hasSuggestionMarks,
  readDoc,
  writeBlock,
  type BlockRef,
} from "./doc-model";
import { diffHunks, isMinorEdit, mergeText, type Hunk } from "./text-diff";

/** How an AI edit lands in the document ("observe": not at all, proposals only). */
export type EditMode = "observe" | "suggest" | "direct" | "auto";

/** A block as the agent read it before calling the model. */
export interface BlockBase {
  blockId: string;
  fingerprint: string;
  protection: ProtectedSelection;
  texts: string[];
}

export type EditOutcome =
  | { kind: "unchanged" }
  | { kind: "applied"; mode: "suggest" | "direct"; rebased: boolean; preview: string }
  | { kind: "conflict"; reason: string; preview: string };

function textNodes(content: PMNode, from: number) {
  const nodes: Array<{ pos: number; text: string }> = [];
  content.descendants((node, pos) => {
    if (node.isText) nodes.push({ pos: from + pos, text: node.text ?? "" });
    return true;
  });
  return nodes;
}

export function captureBlock(block: BlockRef): BlockBase {
  const content = blockContent(block);
  const doc = content.node;
  const slice = doc.slice(0, doc.content.size);
  const protection = protectSelectionSlice(slice, doc.textContent);
  return {
    blockId: block.id,
    fingerprint: blockFingerprint(block),
    protection,
    texts: textNodes(doc, 0).map((node) => node.text),
  };
}

/** Rewritten text of each text node, in document order. */
function rewrittenTexts(base: BlockBase, response: string, schema: PMNode["type"]["schema"]) {
  const slice = restoreProtectedSelection(schema, base.protection, response);
  const texts: string[] = [];
  slice.content.descendants((node) => {
    if (node.isText) texts.push(node.text ?? "");
    return true;
  });
  return texts;
}

/** Same inline structure (marks, atoms, text-node count) as when the block was read. */
function sameStructure(base: BlockBase, current: BlockBase) {
  if (current.texts.length !== base.texts.length) return false;
  const shape = (protection: ProtectedSelection) =>
    protection.markers.map((marker) => marker.kind === "node" ? `${marker.kind}:${marker.nodeType}` : marker.kind).join("|");
  if (shape(base.protection) !== shape(current.protection)) return false;
  // Marks and attributes must match too; compare the slice with all text blanked out.
  const blank = (protection: ProtectedSelection) => JSON.stringify(protection.slice, (key, value) => key === "text" ? "" : value);
  return blank(base.protection) === blank(current.protection);
}

/**
 * Applies the model's annotated rewrite of a block. Runs synchronously from
 * read to write, so no other peer's update can interleave.
 */
export function applyBlockRewrite(
  session: CollabSession,
  base: BlockBase,
  response: string,
  mode: EditMode,
  origin: unknown,
): EditOutcome {
  const preview = protectedRewritePreview(response, base.protection);
  if (!hasProtectedTextChanges(base.protection, response)) return { kind: "unchanged" };
  if (mode === "observe") {
    return { kind: "conflict", reason: "This section is set to Observe, so I only propose changes.", preview };
  }
  const aiTexts = rewrittenTexts(base, response, session.schema);

  const doc = readDoc(session);
  const block = findBlock(doc, base.blockId);
  if (!block) return { kind: "conflict", reason: "The passage was deleted while I was working on it.", preview };
  if (hasSuggestionMarks(blockContent(block).node)) {
    return { kind: "conflict", reason: "The passage already has pending suggested changes.", preview };
  }

  // Stale check: rebase small concurrent edits, otherwise downgrade to a comment.
  let targetTexts = aiTexts;
  let rebased = false;
  const currentFingerprint = blockFingerprint(block);
  if (currentFingerprint !== base.fingerprint) {
    const current = captureBlock(block);
    if (!sameStructure(base, current)) {
      return { kind: "conflict", reason: "You changed the formatting or citations in this passage while I was working.", preview };
    }
    const merged = base.texts.map((original, index) => mergeText(original, current.texts[index], aiTexts[index]));
    if (merged.some((text) => text === null)) {
      return { kind: "conflict", reason: "You edited the same words while I was working.", preview };
    }
    targetTexts = merged as string[];
    rebased = true;
  }

  const content = blockContent(block);
  const nodes = textNodes(content.node, content.from);
  const hunksByNode = nodes.map((node, index) => diffHunks(node.text, targetTexts[index]));
  if (hunksByNode.every((hunks) => hunks.length === 0)) return { kind: "unchanged" };

  const minor = hunksByNode.every((hunks, index) => hunks.length === 0 || isMinorEdit(nodes[index].text, hunks));
  const effective: "suggest" | "direct" = mode === "auto" ? (minor ? "direct" : "suggest") : mode === "direct" ? "direct" : "suggest";

  const state = EditorState.create({ schema: session.schema, doc });
  let tr = state.tr;
  // Apply from the end so earlier positions stay valid.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const hunks: Hunk[] = hunksByNode[index];
    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h];
      const from = nodes[index].pos + hunk.from;
      const to = nodes[index].pos + hunk.to;
      if (hunk.insert) tr.insertText(hunk.insert, from, to);
      else tr.delete(from, to);
    }
  }
  if (effective === "suggest") tr = transformToSuggestionTransaction(tr, state);

  const updated = tr.doc.nodeAt(block.pos);
  if (!updated || updated.attrs.id !== block.id) throw new Error("Could not locate the edited block.");
  writeBlock(session, updated, origin);
  return { kind: "applied", mode: effective, rebased, preview };
}

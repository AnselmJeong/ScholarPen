import type { PunctuationPolicy } from "../../../shared/writing-preferences";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  hasProtectedTextChanges,
  protectSelectionSlice,
  protectedRewritePreview,
  readProtectedRewrite,
  type ProtectedRemovals,
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
import { isMinorEdit, mergeText, type Hunk } from "./text-diff";
import { citationHunks, type CitationSpan } from "./citation-edits";

import { nextSuggestionId, readableHunks, revisedInline, sentenceHunks, suggestReplacement } from "../../../shared/collab/suggested-edits";
import { authorshipBlind } from "../../../shared/collab/ai-authorship";
import { pendingNodeText } from "../../../shared/collab/pending-nodes";
export { nextSuggestionId } from "../../../shared/collab/suggested-edits";

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

/** Inline leaf nodes (citations, math, cross-references, footnotes, line breaks), in the order their protection markers have. */
function inlineNodes(content: PMNode, from: number) {
  const nodes: Array<{ pos: number; size: number }> = [];
  content.descendants((node, pos) => {
    if (node.isText) return false;
    if (node.isLeaf) {
      nodes.push({ pos: from + pos, size: node.nodeSize });
      return false;
    }
    return true;
  });
  return nodes;
}

export function captureBlock(block: BlockRef, punctuation?: PunctuationPolicy): BlockBase {
  const content = blockContent(block);
  // Authorship marks never split the text the model rewrites.
  const doc = authorshipBlind(content.node);
  const slice = doc.slice(0, doc.content.size);
  const protection = protectSelectionSlice(slice, doc.textContent);
  if (punctuation) protection.punctuation = punctuation;
  return {
    blockId: block.id,
    fingerprint: blockFingerprint(block),
    protection,
    texts: textNodes(doc, 0).map((node) => node.text),
  };
}

/** Text nodes reading some text, with each span of it replaced by atom nodes (citation groups). */
function withCitationNodes(content: readonly PMNode[], spans: readonly CitationSpan[], atoms: (span: CitationSpan) => PMNode[]) {
  const range = (from: number, to: number) => {
    const out: PMNode[] = [];
    let offset = 0;
    for (const node of content) {
      const end = offset + node.nodeSize;
      const a = Math.max(from, offset);
      const b = Math.min(to, end);
      if (b > a) out.push(node.cut(a - offset, b - offset));
      offset = end;
    }
    return out;
  };
  const parts: PMNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(...range(cursor, span.from), ...atoms(span));
    cursor = span.to;
  }
  return [...parts, ...range(cursor, Infinity)];
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
  /** Suggestion id shared by every change of one AI request, so it is reviewed as one unit. */
  changeSetId?: number,
  /** Citekeys in references.bib: new `[@key]` text with these keys becomes citation nodes. */
  citekeys?: ReadonlySet<string>,
  /**
   * Protected content the rewrite may remove (whole formatting runs, inline
   * nodes, literal markup). Only an explicit, located deletion passes it: the
   * Assistant's quoted passage. A model's own rewrite never does, so it can
   * never drop protected content it was not asked to delete.
   */
  removals?: ProtectedRemovals,
): EditOutcome {
  const preview = protectedRewritePreview(response, base.protection);
  if (!hasProtectedTextChanges(base.protection, response, removals)) return { kind: "unchanged" };
  if (mode === "observe") {
    return { kind: "conflict", reason: "This section is set to Observe, so I only propose changes.", preview };
  }
  const rewrite = readProtectedRewrite(base.protection, response, removals);
  const aiTexts = rewrite.texts;

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
  const nodes = textNodes(authorshipBlind(content.node), content.from);
  const citation = session.schema.nodes.citation;
  const known = (key: string) => !!citation && !!citekeys?.has(key);
  const hunksFor = (base: (original: string, revised: string) => Hunk[]) => nodes.map((node, index) => citekeys
    ? citationHunks(node.text, targetTexts[index], known, base)
    : base(node.text, targetTexts[index]).map((hunk) => ({ ...hunk, citations: [] as CitationSpan[] })));
  const words = hunksFor(readableHunks);
  // Inline nodes the rewrite removes; the stale check above made sure they are the ones it read.
  const leaves = rewrite.removedNodes.length ? inlineNodes(authorshipBlind(content.node), content.from) : [];
  const removed = rewrite.removedNodes.map((index) => leaves[index]);
  if (removed.some((node) => !node)) throw new Error("The passage's citations and equations no longer match the rewrite.");
  if (words.every((hunks) => hunks.length === 0) && !removed.length) return { kind: "unchanged" };

  // Word-level changes decide whether an edit is minor. A new or removed citation (or other inline node) is a substantive change, never a silent direct edit.
  const minor = !removed.length && words.every((hunks, index) => hunks.length === 0 ||
    (isMinorEdit(nodes[index].text, hunks) && hunks.every((hunk) => !hunk.citations.length)));
  const effective: "suggest" | "direct" = mode === "auto" ? (minor ? "direct" : "suggest") : mode === "direct" ? "direct" : "suggest";
  // A suggestion is reviewed sentence by sentence: the original sentence struck, the revised one written in full.
  const hunksByNode = effective === "suggest" ? hunksFor(sentenceHunks) : words;

  const state = EditorState.create({ schema: session.schema, doc });
  const tr = state.tr;
  // Every change of one request carries one suggestion id, so it is reviewed as one unit.
  const suggestionId = effective === "suggest" ? changeSetId ?? nextSuggestionId(doc) : undefined;
  // Text hunks and removed inline nodes, applied from the end so earlier positions stay valid.
  const steps: Array<{ from: number; to: number; node?: number; hunk?: (typeof hunksByNode)[number][number] }> = [
    ...hunksByNode.flatMap((hunks, index) => hunks.map((hunk) => ({ from: nodes[index].pos + hunk.from, to: nodes[index].pos + hunk.to, node: index, hunk }))),
    ...removed.map((leaf) => ({ from: leaf.pos, to: leaf.pos + leaf.size })),
  ].sort((a, b) => b.from - a.from || b.to - a.to);
  for (const { from, to, node: index, hunk } of steps) {
    if (!hunk || index === undefined) {
      // A removed citation, equation or cross-reference, struck in the same change set: Keep removes it, Revert
      // brings the node back. The Y.Doc keeps no marks on inline nodes, so the struck node is text standing in for it.
      if (suggestionId !== undefined) {
        const node = tr.doc.nodeAt(from)!;
        const standIn = pendingNodeText(node, node.marks);
        tr.replaceWith(from, to, standIn);
        suggestReplacement(tr, from, from + standIn.nodeSize, [], suggestionId);
      } else tr.delete(from, to);
      continue;
    }
    const $from = tr.doc.resolve(from);
    const marks = from === to ? $from.marks() : $from.marksAcross(tr.doc.resolve(to)) ?? $from.marks();
    // Kept words keep their marks; the AI's words carry the authorship mark, kept once the author accepts them.
    const inline = revisedInline(tr.doc, from, nodes[index].text.slice(hunk.from, hunk.to), hunk.insert, marks);
    // One step, so a suggestion never shows the `[@key]` text as inserted and deleted again.
    // A suggested citation is text standing in for the node until the author keeps it (see pending-nodes.ts).
    const parts = hunk.citations.length ? withCitationNodes(inline, hunk.citations, (span) => span.items.map((item) => {
      const node = citation.create({ citekey: item.key, locator: item.locator });
      return suggestionId !== undefined ? pendingNodeText(node) : node;
    })) : inline;
    if (suggestionId !== undefined) suggestReplacement(tr, from, to, parts, suggestionId);
    else if (parts.length) tr.replaceWith(from, to, parts);
    else tr.delete(from, to);
  }

  const updated = tr.doc.nodeAt(block.pos);
  if (!updated || updated.attrs.id !== block.id) throw new Error("Could not locate the edited block.");
  writeBlock(session, updated, origin);
  return { kind: "applied", mode: effective, rebased, preview };
}

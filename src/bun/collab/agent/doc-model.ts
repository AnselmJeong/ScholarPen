import * as Y from "yjs";
import type { Node as PMNode } from "prosemirror-model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { COLLAB_FRAGMENT } from "../../../shared/collab/protocol";
import type { CollabSession } from "../registry";

// BlockNote's ProseMirror layout: doc > blockGroup > blockContainer(id) > [blockContent, blockGroup?]

export interface BlockRef {
  id: string;
  /** Position of the blockContainer node. */
  pos: number;
  node: PMNode;
}

export function readDoc(session: CollabSession): PMNode {
  return yXmlFragmentToProseMirrorRootNode(session.ydoc.getXmlFragment(COLLAB_FRAGMENT), session.schema);
}

export function findBlock(doc: PMNode, blockId: string): BlockRef | null {
  let found: BlockRef | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === blockId) {
      found = { id: blockId, pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/** The innermost block containing a document position. */
export function blockAt(doc: PMNode, pos: number): BlockRef | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer") return { id: node.attrs.id, pos: $pos.before(depth), node };
  }
  return null;
}

export function listBlocks(doc: PMNode): BlockRef[] {
  const blocks: BlockRef[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") blocks.push({ id: node.attrs.id, pos, node });
    return true;
  });
  return blocks;
}

/** The block's own content node (paragraph, heading, …), without nested children. */
export function blockContent(block: BlockRef) {
  const content = block.node.firstChild!;
  const from = block.pos + 2;
  return { node: content, from, to: from + content.content.size };
}

export function hasInlineContent(block: BlockRef) {
  const content = block.node.firstChild;
  return !!content && content.inlineContent && content.textContent.trim().length > 0;
}

export function blockText(block: BlockRef) {
  return blockContent(block).node.textContent;
}

/** Content-only fingerprint used for stale checks (ignores nested children). */
export function blockFingerprint(block: BlockRef) {
  return JSON.stringify(blockContent(block).node.toJSON());
}

export function hasSuggestionMarks(node: PMNode) {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.marks.some((mark) => ["insertion", "deletion", "modification"].includes(mark.type.name))) found = true;
    return !found;
  });
  return found;
}

/** Range covered by a thread's comment mark, or null when the anchor was deleted. */
export function threadRange(doc: PMNode, threadId: string) {
  let from = Infinity;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.marks.some((mark) => mark.type.name === "comment" && mark.attrs.threadId === threadId)) {
      from = Math.min(from, pos);
      to = Math.max(to, pos + node.nodeSize);
    }
    return true;
  });
  return to < 0 ? null : { from, to };
}

/** Blocks whose content the range touches, in document order. */
export function blocksInRange(doc: PMNode, from: number, to: number): BlockRef[] {
  return listBlocks(doc).filter((block) => {
    const content = blockContent(block);
    return content.from < to && from < content.to + 1;
  });
}

/** Heading-delimited section that contains the block (top-level blocks only). */
export function sectionOf(doc: PMNode, blockId: string) {
  const top: BlockRef[] = [];
  doc.firstChild?.forEach((node, offset) => {
    if (node.type.name === "blockContainer") top.push({ id: node.attrs.id, pos: offset + 1, node });
  });
  const isHeading = (block: BlockRef) => block.node.firstChild?.type.name === "heading";
  let index = top.findIndex((block) => block.id === blockId || !!findBlock(block.node, blockId));
  if (index < 0) return null;
  let start = index;
  while (start > 0 && !isHeading(top[start])) start--;
  let end = index + 1;
  while (end < top.length && !isHeading(top[end])) end++;
  const heading = isHeading(top[start]) ? top[start] : null;
  return { heading, blocks: top.slice(start, end) };
}

/** Plain readable text with atoms rendered as their markdown-ish preview. */
export function readableText(doc: PMNode, from = 0, to = doc.content.size) {
  return doc.textBetween(from, to, "\n\n", (node) => {
    const leaf = node.type.spec.leafText;
    return leaf ? leaf(node) : "";
  });
}

function findYBlock(parent: Y.XmlFragment | Y.XmlElement, blockId: string): Y.XmlElement | null {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) return child;
    const nested = findYBlock(child, blockId);
    if (nested) return nested;
  }
  return null;
}

/**
 * Writes one block back to the shared Y.Doc with a minimal diff. Only this
 * block's Y element is touched, so concurrent edits elsewhere are untouched.
 */
export function writeBlock(session: CollabSession, block: PMNode, origin: unknown) {
  const yBlock = findYBlock(session.ydoc.getXmlFragment(COLLAB_FRAGMENT), block.attrs.id);
  if (!yBlock) throw new Error("The block no longer exists.");
  session.ydoc.transact(() => {
    updateYFragment(session.ydoc, yBlock, block, { mapping: new Map(), isOMark: new Map() });
  }, origin);
}

/** Walks a Y type up to the blockContainer that holds it. */
export function yBlockIdOf(type: Y.AbstractType<any> | null): string | null {
  let current: Y.AbstractType<any> | null = type;
  while (current) {
    if (current instanceof Y.XmlElement && current.nodeName === "blockContainer") {
      return current.getAttribute("id") ?? null;
    }
    current = current.parent as Y.AbstractType<any> | null;
  }
  return null;
}

/** Relative positions spanning a block's text, for showing an AI cursor there. */
export function blockCursor(session: CollabSession, blockId: string) {
  const yBlock = findYBlock(session.ydoc.getXmlFragment(COLLAB_FRAGMENT), blockId);
  if (!yBlock) return null;
  const texts: Y.XmlText[] = [];
  const collect = (element: Y.XmlElement) => {
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlText) texts.push(child);
      else if (child instanceof Y.XmlElement && child.nodeName !== "blockGroup") collect(child);
    }
  };
  collect(yBlock);
  if (texts.length === 0) return null;
  const last = texts[texts.length - 1];
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(texts[0], 0)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(last, last.length)),
  };
}

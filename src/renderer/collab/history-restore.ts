import { docToBlocks, type Block, type BlockNoteEditor } from "@blocknote/core";
import { Node as PMNode } from "prosemirror-model";
import { blockTexts, commonIds, type HistoryBlock, type HistoryEntryKind } from "../../shared/collab/history";
import { rpc } from "../rpc";
import { getEditorCollab } from "./editor-collab";
import { acceptedDocument, acceptedPMDoc } from "./suggestions";

type Editor = BlockNoteEditor<any, any, any>;
type AnyBlock = Block<any, any, any>;

/** A history version (ProseMirror JSON from Bun) read with this editor's schema. */
export function readVersion(editor: Editor, doc: unknown): { blocks: AnyBlock[]; texts: HistoryBlock[] } {
  const node = PMNode.fromJSON(editor.pmSchema, doc);
  return { blocks: docToBlocks(node) as AnyBlock[], texts: blockTexts(node) };
}

/** The editor's document as the history sees it: accepted text only. */
export function currentTexts(editor: Editor) {
  return blockTexts(acceptedPMDoc(editor));
}

/**
 * Runs an author action as its own checkpoint: the history first closes what
 * was open, then labels the checkpoint the action produced. The requests go
 * out in order with the action's own changes, so the action runs right away.
 */
export function asCheckpoint<T>(editor: Editor, label: string, action: () => T, kind?: HistoryEntryKind): T {
  const collab = getEditorCollab(editor);
  if (!collab) return action();
  void collab.afterPushes(() => rpc.collabHistoryCheckpoint(collab.docKey)).catch(() => undefined);
  const result = action();
  void collab.afterPushes(() => rpc.collabHistoryCheckpoint(collab.docKey, { kind, label })).catch(() => undefined);
  return result;
}

const serialize = (block: unknown) => JSON.stringify(block);

/**
 * Turns the document into `target`, touching only the blocks that differ:
 * unchanged paragraphs keep their comments and pending suggestions.
 */
export function restoreDocument(editor: Editor, target: AnyBlock[]) {
  const current = editor.document as AnyBlock[];
  const accepted = new Map((acceptedDocument(editor) as AnyBlock[]).map((block) => [block.id, serialize(block)]));
  const kept = commonIds(current.map((block) => block.id), target.map((block) => block.id));
  if (target.length === 0) return false;
  if (kept.size === 0) {
    editor.replaceBlocks(current.map((block) => block.id), target);
    return true;
  }
  let changed = false;
  editor.transact(() => {
    const removed = current.filter((block) => !kept.has(block.id)).map((block) => block.id);
    if (removed.length) {
      editor.removeBlocks(removed);
      changed = true;
    }
    let previous: string | null = null;
    const leading: AnyBlock[] = [];
    for (const block of target) {
      if (kept.has(block.id)) {
        if (accepted.get(block.id) !== serialize(block)) {
          editor.replaceBlocks([block.id], [block]);
          changed = true;
        }
        if (previous === null && leading.length) {
          editor.insertBlocks(leading, block.id, "before");
          changed = true;
        }
        previous = block.id;
      } else if (previous === null) {
        leading.push(block);
      } else {
        editor.insertBlocks([block], previous, "after");
        previous = block.id;
        changed = true;
      }
    }
  });
  return changed;
}

function flatten(blocks: AnyBlock[], out: AnyBlock[] = []) {
  for (const block of blocks) {
    out.push(block);
    flatten(block.children ?? [], out);
  }
  return out;
}

/** Drops ids the document already uses, so a re-inserted block never duplicates one. */
function withFreeIds(editor: Editor, block: AnyBlock): any {
  const { id, children, ...rest } = block;
  return {
    ...rest,
    ...(editor.getBlock(id) ? {} : { id }),
    children: (children ?? []).map((child) => withFreeIds(editor, child)),
  };
}

/**
 * Puts one block back as it is in `source`: its content when the block still
 * exists, otherwise the whole block next to the nearest neighbour that does.
 */
export function restoreBlock(editor: Editor, source: AnyBlock[], blockId: string) {
  const order = flatten(source);
  const at = order.findIndex((block) => block.id === blockId);
  if (at < 0) return false;
  const block = order[at];
  if (editor.getBlock(blockId)) {
    editor.updateBlock(blockId, { type: block.type, props: block.props, content: block.content } as any);
    return true;
  }
  const inserted = withFreeIds(editor, block);
  for (let i = at - 1; i >= 0; i--) {
    if (editor.getBlock(order[i].id) && !flatten(order[i].children ?? []).some((child) => child.id === blockId)) {
      editor.insertBlocks([inserted], order[i].id, "after");
      return true;
    }
  }
  for (let i = at + 1; i < order.length; i++) {
    if (editor.getBlock(order[i].id)) {
      editor.insertBlocks([inserted], order[i].id, "before");
      return true;
    }
  }
  const last = editor.document.at(-1);
  if (!last) return false;
  editor.insertBlocks([inserted], last.id, "after");
  return true;
}

import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";

/**
 * Brings a collaborative editor in line with a JSON snapshot that changed
 * outside it (project find & replace, an external editor). Only the blocks
 * that differ are replaced, so comment anchors and concurrent edits elsewhere
 * survive. Returns true when the document changed.
 */
export function reconcileBlocks(editor: BlockNoteEditor<any, any, any>, target: PartialBlock<any, any, any>[]) {
  const current = editor.document;
  // Normalize the target the same way the editor would store it.
  const serialize = (block: unknown) => JSON.stringify(block);
  const targetKeys = target.map(serialize);
  const currentKeys = current.map(serialize);

  let start = 0;
  while (start < current.length && start < target.length && currentKeys[start] === targetKeys[start]) start++;
  let endCurrent = current.length;
  let endTarget = target.length;
  while (endCurrent > start && endTarget > start && currentKeys[endCurrent - 1] === targetKeys[endTarget - 1]) {
    endCurrent--;
    endTarget--;
  }
  if (start === endCurrent && start === endTarget) return false;

  const replaced = current.slice(start, endCurrent);
  const inserted = target.slice(start, endTarget);
  editor.transact(() => {
    if (replaced.length > 0 && inserted.length > 0 && replaced.length === inserted.length) {
      // Same shape: swap block by block so unchanged blocks in between keep their marks.
      replaced.forEach((block, index) => {
        if (serialize(block) !== serialize(inserted[index])) editor.replaceBlocks([block.id], [inserted[index]]);
      });
    } else if (replaced.length > 0) {
      editor.replaceBlocks(replaced.map((block) => block.id), inserted);
    } else {
      const anchor = current[start - 1] ?? current[0];
      editor.insertBlocks(inserted, anchor.id, start === 0 ? "before" : "after");
    }
  });
  return true;
}

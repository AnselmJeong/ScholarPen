// Reload is view state, scoped to one editor/block, never a persisted document edit.
const listeners = new WeakMap<object, Map<string, Set<() => void>>>();

export function subscribeFigureReload(editor: object, blockId: string, listener: () => void) {
  let blocks = listeners.get(editor);
  if (!blocks) { blocks = new Map(); listeners.set(editor, blocks); }
  let callbacks = blocks.get(blockId);
  if (!callbacks) { callbacks = new Set(); blocks.set(blockId, callbacks); }
  callbacks.add(listener);
  return () => {
    callbacks.delete(listener);
    if (!callbacks.size) blocks.delete(blockId);
  };
}

export function reloadFigure(editor: object, blockId: string) {
  listeners.get(editor)?.get(blockId)?.forEach((listener) => listener());
}

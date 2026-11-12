import type { acceptedDocument } from "./suggestions";
import type { CollabPeer } from "./collab-peer";
import { type AuthorEdit } from "../../shared/author-learning";

function prose(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(item => {
    if (!item || typeof item !== "object") return "";
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "citation" || item.type === "inlineMath") return " [protected] ";
    return prose(item.content);
  }).join("");
}

/** Trusted typing/IME/deletion only, never remote AI edits or programmatic replacement. */
export function observeAuthorEdits(editor: Parameters<typeof acceptedDocument>[0], peer: CollabPeer, onEdit?: (blockId: string, edit: AuthorEdit | null) => void) {
  const dom = editor.prosemirrorView.dom;
  const edits = new Map<string, AuthorEdit>();
  let inputUntil = 0;
  let composing = false;
  const input = (event: Event) => {
    if (!event.isTrusted) return;
    const type = "inputType" in event ? String(event.inputType) : "";
    inputUntil = /Paste|Drop|history/i.test(type) ? 0 : Date.now() + 500;
  };
  const startComposition = (event: Event) => { if (event.isTrusted) composing = true; };
  const endComposition = (event: Event) => { if (event.isTrusted) { composing = false; inputUntil = Date.now() + 500; } };
  dom.addEventListener("beforeinput", input, true);
  dom.addEventListener("input", input, true);
  dom.addEventListener("compositionstart", startComposition, true);
  dom.addEventListener("compositionend", endComposition, true);
  const off = editor.onChange((_editor, context) => {
    for (const change of context.getChanges()) {
      const key = `${peer.peerId}:${change.block.id}`;
      if (["undo", "redo", "undo-redo"].includes(change.source.type) || change.type === "delete") {
        if (edits.has(key)) { edits.delete(key); onEdit?.(change.block.id, null); }
        continue;
      }
      if (change.source.type !== "local" || (!composing && Date.now() > inputUntil)) continue;
      if (change.type !== "update" || change.block.type !== "paragraph") continue;
      const before = prose(change.prevBlock.content).trim();
      const after = prose(change.block.content).trim();
      if (!before || !after || before === after || before.length > 8_000 || after.length > 8_000) continue;
      const existing = edits.get(key);
      // Coalesce a paragraph's keystrokes into one observation, not repeated votes.
      const original = existing?.after === before ? existing.before : before;
      if (original === after) { edits.delete(key); onEdit?.(change.block.id, null); }
      else {
        const edit = { blockId: change.block.id, before: original, after, observedAt: Date.now() };
        edits.set(key, edit); onEdit?.(change.block.id, edit);
      }
    }
    inputUntil = 0;
  });
  return () => {
    off();
    dom.removeEventListener("beforeinput", input, true);
    dom.removeEventListener("input", input, true);
    dom.removeEventListener("compositionstart", startComposition, true);
    dom.removeEventListener("compositionend", endComposition, true);
  };
}

import type { ProtectedSelection } from "../../../shared/ai-text-protection";

export interface EditableSegment { id: string; text: string }

/** Keep all structural tokens on the host; the model edits only plain-text gaps. */
export function editableSegments(selections: ProtectedSelection[]) {
  const slots: Array<EditableSegment & { block: number; from: number; to: number }> = [];
  selections.forEach((selection, block) => {
    let cursor = 0, editable = false, index = 0;
    for (const marker of selection.markers) {
      const at = selection.protectedText.indexOf(marker.token, cursor);
      if (at < 0) throw new Error("Invalid protected source text.");
      if (editable && at > cursor) slots.push({
        id: `b${block}s${index++}`, text: selection.protectedText.slice(cursor, at), block, from: cursor, to: at,
      });
      if (marker.kind === "text-open") editable = true;
      if (marker.kind === "text-close") editable = false;
      cursor = at + marker.token.length;
    }
  });
  return slots;
}

/** Strict identifiers prevent a malformed answer from changing the wrong passage. */
export function parseTextEdits(response: string, selections: ProtectedSelection[]) {
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1");
  if (!cleaned.startsWith("{")) return null; // Legacy annotated responses still pass the original strict validator.
  const data = JSON.parse(cleaned) as { reply?: unknown; edits?: unknown; scope?: unknown };
  if (data.scope === "document") return { reply: "", parts: null, wantsDocument: true };
  if (typeof data.reply !== "string" || !Array.isArray(data.edits)) throw new Error("The AI returned an incomplete text-edit response.");
  const slots = editableSegments(selections);
  const byId = new Map(slots.map(slot => [slot.id, slot]));
  const replacements = new Map<string, string>();
  for (const edit of data.edits) {
    if (!edit || typeof edit.id !== "string" || typeof edit.text !== "string" || !byId.has(edit.id) || replacements.has(edit.id)) {
      throw new Error("The AI returned an unknown or duplicate text segment.");
    }
    if (edit.text.includes("⟦SP:")) throw new Error("The AI put an internal control marker into editable prose.");
    // Empty text nodes cannot be restored without dropping formatting/structure.
    if (!edit.text.length) throw new Error("The AI removed an entire text segment. Keep its text and formatting intact.");
    replacements.set(edit.id, edit.text);
  }
  if (replacements.size !== slots.length) throw new Error("The AI omitted a text segment. Return every segment, including unchanged ones.");
  const parts = selections.map(selection => selection.protectedText);
  for (const slot of [...slots].reverse()) {
    const original = parts[slot.block];
    parts[slot.block] = original.slice(0, slot.from) + replacements.get(slot.id)! + original.slice(slot.to);
  }
  return { reply: data.reply, parts, wantsDocument: false };
}

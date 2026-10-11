import type { ProtectedSelection } from "./ai-text-protection";

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
  const data = JSON.parse(cleaned) as { reply?: unknown; edits?: unknown; scope?: unknown; question?: unknown };
  if (data.scope === "document") return { reply: "", parts: null, wantsDocument: true, question: "" };
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
  const question = typeof data.question === "string" ? data.question.trim() : "";
  return { reply: data.reply, parts, wantsDocument: false, question };
}

const MARKER = /⟦SP:[^⟧]*⟧/g;

function jsonObject(response: string) {
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1").trim();
  if (cleaned.startsWith("{")) return cleaned;
  // Some models add a sentence before the object.
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start && /"edits"\s*:/.test(cleaned) ? cleaned.slice(start, end + 1) : null;
}

/**
 * Turns an inline-edit answer into the annotated passage the editor applies.
 * The model only sees and returns plain-text segments, so it can never drop a
 * citation, footnote or formatting marker: the host puts them back. Lenient
 * where nothing can be lost: unchanged segments may be omitted, an emptied
 * segment keeps its text, and stray markers are removed. A non-JSON answer is
 * returned as is, for the strict marker validator.
 */
export function resolveInlineEditResponse(response: string, selection: ProtectedSelection): string {
  const json = jsonObject(response);
  if (json === null) return response;
  let data: { edits?: unknown };
  try { data = JSON.parse(json); }
  catch { throw new Error("The AI returned an incomplete answer. Retry the rewrite; the document was not modified."); }
  if (!Array.isArray(data.edits)) throw new Error("The AI returned no edits. Retry the rewrite; the document was not modified.");
  const slots = editableSegments([selection]);
  const byId = new Map(slots.map(slot => [slot.id, slot]));
  const replacements = new Map<string, string>();
  for (const edit of data.edits) {
    if (!edit || typeof edit.id !== "string" || typeof edit.text !== "string") continue;
    const slot = byId.get(edit.id.trim());
    if (!slot) throw new Error(`The AI returned an unknown text segment (${edit.id}). Retry the rewrite; the document was not modified.`);
    const text = edit.text.replace(MARKER, "");
    replacements.set(slot.id, text.trim() ? text : slot.text);
  }
  let passage = selection.protectedText;
  for (const slot of [...slots].reverse()) {
    if (replacements.has(slot.id)) passage = passage.slice(0, slot.from) + replacements.get(slot.id)! + passage.slice(slot.to);
  }
  return passage;
}

/** Best-effort readable text of a partly streamed JSON answer, for the live preview. */
export function streamingSegmentPreview(response: string): string | null {
  if (!/^\s*(?:<think>[\s\S]*?<\/think>\s*)?(?:```(?:json)?\s*)?\{/.test(response)) return null;
  const parts: string[] = [];
  for (const match of response.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
    try { parts.push(JSON.parse(`"${match[1].replace(/\\$/, "")}"`)); }
    catch { parts.push(match[1]); }
  }
  return parts.join("");
}

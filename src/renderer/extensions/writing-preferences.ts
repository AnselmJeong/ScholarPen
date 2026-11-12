import { rpc } from "../rpc";
import { DEFAULT_PUNCTUATION, type WritingPreferences } from "../../shared/writing-preferences";
export const WRITING_PREFERENCES_CHANGED = "scholarpen:writing-preferences";
let snapshot: WritingPreferences = { version: 1, revision: 0, punctuation: { ...DEFAULT_PUNCTUATION } };
export function punctuationSnapshot() { return { ...snapshot.punctuation }; }
export async function refreshWritingPreferences() { const next = await rpc.getWritingPreferences(); snapshot = next; return next; }
export async function saveWritingPreferences(value: WritingPreferences) {
  snapshot = await rpc.saveWritingPreferences(value.revision, value.punctuation);
  window.dispatchEvent(new CustomEvent(WRITING_PREFERENCES_CHANGED)); return snapshot;
}

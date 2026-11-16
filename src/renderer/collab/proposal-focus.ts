/**
 * "Show in manuscript" from the Review & Revision workspace: the document is
 * opened, and its margin selects the proposal's card once it is on screen.
 */
let pending: { filename: string; key: string } | null = null;
const listeners = new Set<() => void>();

export function requestProposalFocus(filename: string, key: string) {
  pending = { filename, key };
  for (const listener of [...listeners]) listener();
}

/** Hands the request to the margin whose document holds it (docKey ends with the filename). */
export function takeProposalFocus(docKey: string, has: (key: string) => boolean) {
  if (!pending || !docKey.endsWith(`::${pending.filename}`) || !has(pending.key)) return null;
  const { key } = pending;
  pending = null;
  return key;
}

export function subscribeProposalFocus(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

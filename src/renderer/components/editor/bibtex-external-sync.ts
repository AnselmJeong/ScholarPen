export type ExternalBibtexSyncDecision = "unchanged" | "reload" | "conflict";

export function decideExternalBibtexSync(
  savedContent: string,
  incomingContent: string,
  hasUnsavedChanges: boolean,
): ExternalBibtexSyncDecision {
  if (incomingContent === savedContent) return "unchanged";
  return hasUnsavedChanges ? "conflict" : "reload";
}

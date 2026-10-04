import type * as Y from "yjs";

/**
 * Work zones: per-section agreements about what the AI may do there, keyed by
 * the section's heading block id and stored in the shared Y.Doc.
 */
export const ZONES_MAP = "zones";

/**
 * observe: comments and proposals only, never text changes.
 * suggest: every AI edit is a tracked suggestion.
 * edit:    the AI applies edits directly (highlighted, undoable) and may draft the section.
 * auto:    the default — typo fixes apply directly, content changes are suggestions.
 */
export type ZoneTrust = "observe" | "suggest" | "edit" | "auto";

export interface Zone {
  trust: ZoneTrust;
  /** What the author wants the AI to write here, used when drafting. */
  brief?: string;
}

export const ZONE_LABEL: Record<ZoneTrust, string> = {
  auto: "Auto",
  observe: "Observe",
  suggest: "Suggest",
  edit: "AI drafts",
};

export function zoneOf(zones: Y.Map<Zone>, headingId: string | null | undefined): Zone {
  return (headingId ? zones.get(headingId) : undefined) ?? { trust: "auto" };
}

export function setZone(zones: Y.Map<Zone>, headingId: string, zone: Zone) {
  if (zone.trust === "auto" && !zone.brief) zones.delete(headingId);
  else zones.set(headingId, zone);
}

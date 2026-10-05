/**
 * A change set is everything one AI request changed, reviewed as a unit.
 * All its tracked suggestions share one suggestion id; this map (in the shared
 * Y.Doc) says where that id came from.
 */
export const CHANGE_SETS_MAP = "changeSets";

export interface ChangeSetInfo {
  /** The suggestion id carried by every insertion/deletion mark of this change set. */
  id: number;
  label: string;
  persona: string;
  threadId?: string;
  createdAt: number;
}

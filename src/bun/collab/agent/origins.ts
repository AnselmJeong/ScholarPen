/** Yjs transaction origin of every AI text edit; the undo manager tracks it. */
export const AI_ORIGIN = "ai-agent";
/** Origin of AI bookkeeping (comment anchors, review state) that "undo AI edit" must not revert. */
export const AI_META_ORIGIN = "ai-meta";
/** Y.Doc map of blocks the AI wrote directly: block id → { at, source }. */
export const AI_EDITS_MAP = "aiEdits";

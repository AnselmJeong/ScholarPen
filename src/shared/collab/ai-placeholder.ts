/**
 * Placeholder blocks ScholarPen AI puts where it is about to write while it
 * drafts a section: one per planned paragraph, carrying the plan ("intent").
 * They are transient: each is replaced by its paragraph, and any left when a
 * job ends (or the app restarts) is removed. Export skips them.
 */
export const AI_PLACEHOLDER_TYPE = "aiPlaceholder";

export function isAIPlaceholder(block: { type?: unknown } | null | undefined) {
  return block?.type === AI_PLACEHOLDER_TYPE;
}

/** Leaves placeholders out of a BlockNote block list (top level and nested). */
export function withoutAIPlaceholders<T extends { type?: unknown; children?: unknown }>(blocks: T[]): T[] {
  return blocks.filter(block => !isAIPlaceholder(block)).map(block => Array.isArray(block.children)
    ? { ...block, children: withoutAIPlaceholders(block.children as T[]) }
    : block);
}

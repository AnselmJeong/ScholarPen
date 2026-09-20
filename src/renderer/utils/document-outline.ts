export interface OutlineBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly OutlineBlock[];
}

export interface OutlineHeading {
  id: string;
  title: string;
  level: number;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
}

export interface DocumentOutline {
  headings: OutlineHeading[];
  sectionByBlock: Map<string, string | null>;
}

function headingText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(headingText).join("");
  if (!content || typeof content !== "object") return "";
  const item = content as Record<string, unknown>;
  if (typeof item.text === "string") return item.text;
  const props = item.props as Record<string, unknown> | undefined;
  if (item.type === "inlineMath") return String(props?.formula ?? "");
  if (item.type === "citation") return `[@${props?.citekey ?? ""}]`;
  if (item.type === "crossReference") return `@${props?.label ?? ""}`;
  return headingText(item.content);
}

/** Heading levels define sections; block nesting alone does not create a heading. */
export function buildDocumentOutline(blocks: readonly OutlineBlock[]): DocumentOutline {
  const headings: OutlineHeading[] = [];
  const sectionByBlock = new Map<string, string | null>();
  const ancestors: OutlineHeading[] = [];
  let section: string | null = null;
  const visit = (items: readonly OutlineBlock[]) => {
    for (const block of items) {
      if (block.type === "heading" && block.id) {
        const rawLevel = Number(block.props?.level ?? 1);
        const level = Number.isFinite(rawLevel) ? Math.max(1, Math.min(6, Math.trunc(rawLevel))) : 1;
        while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
        const parent = ancestors.at(-1);
        if (parent) parent.hasChildren = true;
        const heading: OutlineHeading = {
          id: block.id, title: headingText(block.content).replace(/\s+/g, " ").trim() || "Untitled heading",
          level, depth: ancestors.length, parentId: parent?.id ?? null, hasChildren: false,
        };
        headings.push(heading);
        ancestors.push(heading);
        section = block.id;
      }
      if (block.id) sectionByBlock.set(block.id, section);
      if (block.children) visit(block.children);
    }
  };
  visit(blocks);
  return { headings, sectionByBlock };
}

export function visibleOutlineHeadings(headings: readonly OutlineHeading[], collapsed: ReadonlySet<string>): OutlineHeading[] {
  const hidden = new Set<string>();
  return headings.filter((heading) => {
    if (heading.parentId && (collapsed.has(heading.parentId) || hidden.has(heading.parentId))) {
      hidden.add(heading.id);
      return false;
    }
    return true;
  });
}

export function visibleActiveHeading(headings: readonly OutlineHeading[], visible: readonly OutlineHeading[], activeId: string | null): string | null {
  const byId = new Map(headings.map((heading) => [heading.id, heading]));
  const visibleIds = new Set(visible.map((heading) => heading.id));
  let id = activeId;
  while (id && !visibleIds.has(id)) id = byId.get(id)?.parentId ?? null;
  return id;
}

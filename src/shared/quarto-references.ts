import { quartoAttributes, tableWidthRatios } from "./quarto-attributes";

/** Quarto reserves these namespaces for document references, never BibTeX keys. */
const RESERVED_PREFIX = /^(?:fig|tbl|lst|tip|nte|wrn|imp|cau|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg|eq|sec)-/i;
export const LABEL_PREFIXES: Record<string, string> = {
  heading: "sec", figure: "fig", image: "fig", table: "tbl", math: "eq",
};

export function isQuartoReference(value: string): boolean {
  return RESERVED_PREFIX.test(value);
}

export function validQuartoLabel(value: string, type?: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][\w:.-]*$/.test(value)
    && isQuartoReference(value)
    && (!type || value.startsWith(`${LABEL_PREFIXES[type]}-`));
}

export function validFigureDimension(value: string): boolean {
  return value === "" || /^(?:\d+(?:\.\d+)?|\.\d+)(?:%|px|in|cm|mm|pt)?$/.test(value)
    && Number.parseFloat(value) > 0;
}

export interface ReferenceBlock {
  id?: string;
  type: string;
  props?: Record<string, any>;
  content?: any;
  children?: ReferenceBlock[];
}

export function blockLabel(block: ReferenceBlock): string {
  const label = block.props?.label;
  if (typeof label === "string" && label) return label;
  if (block.type === "figure" && Number(block.props?.figureNumber) > 0) return `fig-${block.props!.figureNumber}`;
  return "";
}

export function inlineText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(inlineText).join("");
  if (!value || typeof value !== "object") return "";
  return typeof value.text === "string" ? value.text : inlineText(value.content);
}

export interface ReferenceTarget { label: string; blockId: string; type: string; title: string }
export function collectReferenceTargets(blocks: ReferenceBlock[]): ReferenceTarget[] {
  return blocks.flatMap((block) => {
    const label = blockLabel(block);
    return [
      ...(label ? [{ label, blockId: block.id ?? "", type: block.type,
        title: String(block.props?.caption || block.props?.formula || inlineText(block.content) || label) }] : []),
      ...collectReferenceTargets(block.children ?? []),
    ];
  });
}

/** Read-time compatibility only: callers choose when to save the edited document. */
export function normalizeQuartoBlocks<T extends ReferenceBlock>(blocks: T[]): T[] {
  function inline(value: any): any {
    if (Array.isArray(value)) return value.map(inline);
    if (!value || typeof value !== "object") return value;
    if (value.type === "citation" && isQuartoReference(value.props?.citekey ?? value.citekey ?? "")) {
      return { type: "crossReference", props: { label: value.props?.citekey ?? value.citekey,
        locator: value.props?.locator ?? "", bracketed: true } };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)]));
  }
  const normalized = blocks.map((original) => {
    const block = { ...original, props: { ...original.props }, content: inline(original.content),
      children: normalizeQuartoBlocks(original.children ?? []) };
    if (block.type === "image") {
      block.type = "figure";
      block.props = { ...block.props, label: block.props.label ?? "", caption: block.props.caption ?? "",
        altText: block.props.altText ?? block.props.name ?? "",
        width: block.props.width ?? (Number(block.props.previewWidth) > 0 ? `${block.props.previewWidth}px` : ""),
        height: block.props.height ?? "", alignment: block.props.alignment ?? block.props.textAlignment ?? "center" };
    }
    if (block.type === "figure" && !block.props.label && Number(block.props.figureNumber) > 0) {
      block.props.label = `fig-${block.props.figureNumber}`;
    }
    if (block.type === "heading") {
      // Imports keep Pandoc heading attributes as text. Preserve identifiers and
      // classes (especially .unnumbered) through the editor and subsequent exports.
      const text = inlineText(block.content);
      const match = text.match(/\s*\{((?:(?:#sec-[\w:.-]+|\.[A-Za-z][\w-]*)\s*)+)\}\s*$/);
      const label = match?.[1].match(/#(sec-[\w:.-]+)/)?.[1];
      if (match && (!label || !block.props.label || block.props.label === label)
        && (typeof block.content === "string" || block.content?.at(-1)?.type === "text")) {
        if (label) block.props.label = label;
        const classes = match[1].split(/\s+/).filter((attr) => attr.startsWith(".")).map((attr) => attr.slice(1));
        if (classes.length) block.props.quartoClasses = [...new Set([
          ...String(block.props.quartoClasses ?? "").split(/\s+/).filter(Boolean), ...classes,
        ])].join(" ");
        let remaining = match[0].length;
        if (typeof block.content === "string") block.content = text.slice(0, -remaining);
        else if (Array.isArray(block.content)) {
          for (let index = block.content.length - 1; index >= 0 && remaining; index--) {
            const item = block.content[index];
            if (typeof item.text !== "string") break;
            const remove = Math.min(remaining, item.text.length);
            block.content[index] = { ...item, text: item.text.slice(0, item.text.length - remove) };
            remaining -= remove;
          }
        }
      }
    }
    return block as T;
  });
  // Earlier imports left a table caption/attributes in the following paragraph.
  // Upgrade only plain, unstyled text; never discard richer caption content.
  return normalized.filter((block, index) => {
    const table = normalized[index - 1];
    if (block.type !== "paragraph" || table?.type !== "table" || table.props?.label || table.props?.caption || block.children?.length) return true;
    const plain = typeof block.content === "string" || Array.isArray(block.content) && block.content.every((part: any) =>
      part.type === "text" && !Object.values(part.styles ?? {}).some(Boolean));
    if (!plain) return true;
    const match = inlineText(block.content).match(/^:\s*(.*?)\s*\{([^{}]*)\}\s*$/);
    if (!match) return true;
    const attrs = quartoAttributes(match[2]);
    if (!attrs.label?.startsWith("tbl-") && !attrs["tbl-colwidths"]) return true;
    table.props = { ...table.props, caption: match[1], label: attrs.label ?? "" };
    const widths = tableWidthRatios(attrs["tbl-colwidths"] ?? "", table.content?.rows?.[0]?.cells?.length ?? 0);
    if (widths) table.content.columnWidths = widths;
    return false;
  });
}

export function duplicateReferenceLabels(blocks: ReferenceBlock[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const { label } of collectReferenceTargets(blocks)) {
    if (seen.has(label)) duplicate.add(label);
    seen.add(label);
  }
  return [...duplicate];
}

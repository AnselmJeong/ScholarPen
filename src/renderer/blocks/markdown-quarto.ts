import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { quartoAttributes } from "../../shared/quarto-attributes";
import { normalizeFigureCaption } from "./caption-markdown";
export { tableWidthRatios } from "../../shared/quarto-attributes";

/** Use Markdown source positions so code, image URLs with parentheses, and nested
 * blocks do not get rewritten by broad image/attribute regular expressions. */
export function prepareQuartoBlocks(source: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  let prefix = "SCHOLARPENQUARTOBLOCK";
  while (source.includes(prefix)) prefix += "Z";
  const figures = new Map<string, Record<string, unknown>>();
  const tables = new Map<string, { caption: string; label: string; widths: string; align: (string | null)[] }>();
  const edits: { start: number; end: number; text: string }[] = [];
  const consumedCaptions = new Set<RootContent>();
  function visit(node: Root | RootContent) {
    if (!("children" in node)) return;
    const children = node.children;
    children.forEach((child, index) => {
      if (child.type === "paragraph" && child.children[0]?.type === "image") {
        const image = child.children[0];
        const trailing = source.slice(image.position!.end.offset!, child.position!.end.offset!).trim();
        if (!trailing || /^\{[^\n]*\}$/.test(trailing)) {
          const attrs = quartoAttributes(trailing);
          const token = `${prefix}FIG${figures.size}END`;
          // MDAST alt text has already decoded Markdown escapes, including TeX
          // braces and row separators. Retain the caption's Markdown source.
          const rawImage = source.slice(image.position!.start.offset!, image.position!.end.offset!);
          const captionEnd = rawImage.lastIndexOf("](");
          const caption = captionEnd >= 2 ? rawImage.slice(2, captionEnd) : image.alt ?? "";
          figures.set(token, { url: image.url, caption: normalizeFigureCaption(caption), altText: attrs["fig-alt"] ?? "",
            label: attrs.label ?? "", figureNumber: 0, width: attrs.width ?? "", height: attrs.height ?? "",
            alignment: attrs["fig-align"] ?? "center" });
          edits.push({ start: child.position!.start.offset!, end: child.position!.end.offset!, text: token });
          return;
        }
      }
      if (child.type === "table") {
        const token = `${prefix}TBL${tables.size}END`;
        const metadata = { caption: "", label: "", widths: "", align: child.align ?? [] };
        tables.set(token, metadata);
        let hasCaption = false;
        // Prefer the existing below-table convention when a caption lies
        // between two tables. Never assign the same caption to both tables.
        for (const candidate of [children[index + 1], children[index - 1]]) {
          if (candidate?.type !== "paragraph" || consumedCaptions.has(candidate)) continue;
          const raw = source.slice(candidate.position!.start.offset!, candidate.position!.end.offset!);
          const caption = raw.match(/^:\s*([\s\S]*?)(?:\s*\{([^{}]*)\})?\s*$/);
          if (caption) {
            const attrs = quartoAttributes(caption[2] ?? "");
            Object.assign(metadata, { caption: caption[1], label: attrs.label ?? "", widths: attrs["tbl-colwidths"] ?? "" });
            consumedCaptions.add(candidate);
            const isBelow = candidate === children[index + 1];
            edits.push({ start: candidate.position!.start.offset!, end: candidate.position!.end.offset!, text: isBelow ? token : "" });
            if (!isBelow) edits.push({ start: child.position!.end.offset!, end: child.position!.end.offset!,
              text: `\n\n${" ".repeat(child.position!.start.column - 1)}${token}` });
            hasCaption = true;
            break;
          }
        }
        if (!hasCaption) edits.push({ start: child.position!.end.offset!, end: child.position!.end.offset!,
          text: `\n\n${" ".repeat(child.position!.start.column - 1)}${token}` });
      }
      visit(child as RootContent);
    });
  }
  visit(tree);
  let markdown = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return { markdown, figures, tables };
}

import type { RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export interface MarkdownImageDestination {
  url: string;
  start: number;
  end: number;
}

/** Source offsets let us change URLs without reformatting the manuscript. */
export function markdownImageDestinations(markdown: string): MarkdownImageDestination[] {
  const source = markdown.replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/,
    (frontmatter) => frontmatter.replace(/[^\r\n]/g, " "));
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const references = new Set<string>();
  function visit(nodes: RootContent[], callback: (node: RootContent) => void) {
    for (const node of nodes) {
      callback(node);
      if ("children" in node) visit(node.children, callback);
    }
  }
  visit(tree.children, (node) => {
    if (node.type === "imageReference") references.add(node.identifier);
  });
  const destinations: MarkdownImageDestination[] = [];
  visit(tree.children, (node) => {
    if (node.type !== "image" && !(node.type === "definition" && references.has(node.identifier))) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw new Error("Cannot locate an image in the export.");
    const raw = markdown.slice(start, end);
    const delimiter = node.type === "image" ? "](" : "]:";
    const offset = raw.indexOf(node.url, raw.lastIndexOf(delimiter) + delimiter.length);
    if (offset < 0) throw new Error(`Cannot locate the image URL: ${node.url}`);
    destinations.push({ url: node.url, start: start + offset, end: start + offset + node.url.length });
  });
  return destinations;
}

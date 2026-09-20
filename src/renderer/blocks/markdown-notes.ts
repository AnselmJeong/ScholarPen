import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { quartoAttributes } from "../../shared/quarto-attributes";
import { protectedMarkdownRanges } from "./markdown-math";

export const NOTE_MARKER = "<!-- scholarpen-note -->";
interface MarkdownNote { title: string; body: string }

/** Extract containers before the ordinary Markdown parser flattens fenced divs. */
export function prepareMarkdownNotes(source: string) {
  let prefix = "SCHOLARPENNOTEBLOCK";
  while (source.includes(prefix)) prefix += "Z";
  const notes = new Map<string, MarkdownNote>();
  const edits: { start: number; end: number; text: string }[] = [];
  const protectedRanges = protectedMarkdownRanges(source);
  const protectedAt = (offset: number) => protectedRanges.some(([start, end]) => offset >= start && offset < end);
  const lines = [...source.matchAll(/^.*(?:\n|$)/gm)].filter((line) => line[0]);
  function add(start: number, end: number, note: MarkdownNote) {
    const token = `${prefix}${notes.size}END`;
    notes.set(token, note);
    edits.push({ start, end, text: `\n${token}\n` });
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opening = line[0].trimEnd().match(/^ {0,3}(:{3,})\s*(?:\{([^}]*)\}|(callout-note))\s*$/);
    if (!opening || protectedAt(line.index!) || !(opening[3] || /(?:^|\s)\.callout-note(?:\s|$)/.test(opening[2]))) continue;
    const stack = [opening[1].length];
    let end = i + 1;
    for (; end < lines.length; end++) {
      if (protectedAt(lines[end].index!)) continue;
      const fence = lines[end][0].trimEnd().match(/^ {0,3}(:{3,})(.*)$/);
      if (!fence) continue;
      if (fence[2].trim()) stack.push(fence[1].length);
      else if (fence[1].length >= stack[stack.length - 1]) stack.pop();
      if (!stack.length) break;
    }
    if (stack.length) continue; // Preserve incomplete input verbatim.
    const attrs = quartoAttributes(opening[2] ?? "");
    let body = source.slice(line.index! + line[0].length, lines[end].index!).trim();
    const heading = body.match(/^#{1,6}\s+([^\n]+)\n*/);
    const title = (attrs.title ?? heading?.[1] ?? "읽는 법").replace(/&amp;/g, "&");
    if (!attrs.title && heading) body = body.slice(heading[0].length);
    add(line.index!, lines[end].index! + lines[end][0].length, { title, body });
    i = end;
  }
  // Ordinary blockquotes remain ordinary unless explicitly marked, or titled
  // with the two default note names used in earlier portable exports.
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  for (const [index, node] of tree.children.entries()) {
    if (node.type !== "blockquote") continue;
    let start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    if (edits.some((edit) => start >= edit.start && start < edit.end)) continue;
    const raw = source.slice(start, end).replace(/^ {0,3}> ?/gm, "");
    const heading = raw.match(/^\*\*(.+)\*\*\s*\n(?:\s*\n)?/);
    if (!heading) continue;
    const previous = tree.children[index - 1];
    const marked = previous?.type === "html" && previous.value.trim() === NOTE_MARKER;
    if (!marked && !["읽는 법", "Note"].includes(heading[1])) continue;
    if (marked) start = previous.position!.start.offset!;
    add(start, end, { title: heading[1].replace(/\\([\\*])/g, "$1"), body: raw.slice(heading[0].length) });
  }
  let markdown = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return { markdown, notes };
}

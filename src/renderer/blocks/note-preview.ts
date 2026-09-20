import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { prepareMarkdownNotes } from "./markdown-notes";
import { prepareMarkdownMath, remarkRestoreScholarMath } from "./markdown-math";

/** Use the same note boundaries as import; render without executing raw HTML. */
export function remarkScholarNotes(prepared: ReturnType<typeof prepareMarkdownNotes>) {
  return (tree: Root) => {
    function restore(parent: Root | RootContent) {
      if (!("children" in parent)) return;
      parent.children = parent.children.map((node) => {
        const token = node.type === "paragraph" && node.children.length === 1 && node.children[0].type === "text"
          ? node.children[0].value.trim() : "";
        const note = prepared.notes.get(token);
        if (note) {
          const nested = prepareMarkdownNotes(note.body);
          const math = prepareMarkdownMath(nested.markdown);
          const body = unified().use(remarkParse).use(remarkGfm).parse(math.markdown);
          remarkRestoreScholarMath(math)(body);
          remarkScholarNotes(nested)(body);
          return { type: "blockquote", data: { hName: "aside", hProperties: { className: ["scholar-note-preview"] } },
            children: [{ type: "paragraph", data: { hProperties: { className: ["scholar-note-title"] } },
              children: [{ type: "text", value: note.title }] }, ...body.children] };
        }
        restore(node);
        return node;
      }) as typeof parent.children;
    }
    restore(tree);
  };
}
